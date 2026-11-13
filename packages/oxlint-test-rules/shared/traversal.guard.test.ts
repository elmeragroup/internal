import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import plugin from "../index.ts";

/*
 * Unit under test: every recursive analysis the rules run, through the published plugin entry.
 * Oracle: `traversal.ts`'s contract: every analysis that follows values is bounded, so a value that
 * refers to itself, or one doubled down a long chain, finishes with a verdict instead of a crash or
 * a hang. Each rule reads every value builder below in each place it reads a value; the suite fails
 * on any plugin error oxlint reports (a stack overflow surfaces as one) and on a run that does not
 * finish. Verdicts are not asserted here; each rule's own suite owns them.
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const oxlint = join(packageRoot, "node_modules", ".bin", "oxlint");

/** How many links a doubling chain has: 2^25 unfolded steps, far past the budget. */
const LINKS = 25;

/** A value builder: the expression built from the previous link (`p`), read twice where it can be. */
const BUILDERS = {
  array: (p: string) => `[${p}, ${p}]`,
  "array spread": (p: string) => `[...${p}, ...${p}]`,
  object: (p: string) => `{ width: ${p}, height: ${p}, retry: ${p}, className: ${p}, now: ${p} }`,
  "object spread": (p: string) => `{ ...${p}, ...${p} }`,
  member: (p: string) => `({ k: ${p}, j: ${p} }).k`,
  template: (p: string) => `\`\${${p}}\${${p}}\``,
  plus: (p: string) => `${p} + ${p}`,
  join: (p: string) => `join(${p}, ${p})`,
  url: (p: string) => `new URL(${p}, ${p})`,
  condition: (p: string) => `flag ? ${p} : ${p}`,
  logical: (p: string) => `${p} || ${p}`,
  "class list": (p: string) => `[...${p}.classList, ...${p}]`,
  measure: (p: string) => `${p}.offsetWidth + ${p}.offsetWidth`,
  scale: (p: string) => `${p} / ${p}`,
  round: (p: string) => `Math.round(${p} * ${p})`,
  "push spread": (p: string) =>
    `(() => {\n  const out = [];\n  out.push(...${p}, ...${p});\n  return out;\n})()`,
  "flat map": (p: string) => `[...${p}, ...${p}].flatMap((e) => [e])`,
  "date stamp": (p: string) => `new Date(${p} + ${p}).getTime()`,
};

/** Each rule and the places it reads a value, `V` standing for the value. */
const HOLES = {
  "no-test-retry": ['it("x", { retry: V }, () => {});', 'it("y", V, () => {});'],
  "no-fixed-delay": ["setTimeout(fire, V);", "V(fire, 100);", "await sleep(V);"],
  "no-wall-clock": ["expect(V).toBe(1);", "log(V - start);"],
  "no-source-reading-tests": ["readFileSync(V);", "for (const f of V) readFileSync(f);"],
  "no-class-assertions": [
    "render(<Button className={V} />);",
    "expect(button).toHaveClass(V);",
    'expect(V).toContain("h-9");',
  ],
  "no-geometry-assertions": ["expect(V).toBe(120);", "expect(panel.offsetWidth).toBe(V);"],
};

/** A chain of `LINKS` doubled links ending in `V`, and a binding that refers to itself as `S`. */
function builtFixture(builder: (previous: string) => string, holes: ReadonlyArray<string>): string {
  const chain = [
    "const v0 = panel;",
    ...Array.from({ length: LINKS }, (_, index) => `const v${index + 1} = ${builder(`v${index}`)};`),
    `const self = ${builder("self")};`,
  ];
  const reads = holes.flatMap((hole) => [hole.replaceAll("V", `v${LINKS}`), hole.replaceAll("V", "self")]);
  return [...chain, ...reads].join("\n");
}

/**
 * A member chain far longer than the budget's depth (`m${n} = m${n - 1}.k`), evaluated link by link
 * so each read starts warm: the chain of values it builds stays within the depth the budget charges.
 */
function memberChainFixture(holes: ReadonlyArray<string>): string {
  const links = 3_000;
  const chain = [
    "const m0 = panel;",
    ...Array.from({ length: links }, (_, index) => `const m${index + 1} = m${index}.k;`),
  ];
  const warm = Array.from({ length: links / 100 }, (_, index) => `use(m${(index + 1) * 100});`);
  return [...chain, ...warm, ...holes.map((hole) => hole.replaceAll("V", `m${links}`))].join("\n");
}

/** Helpers that call the next one twice and a helper that calls itself, each waiting or reading the clock. */
function helperFixture(): string {
  const helpers = [
    `function h${LINKS}(ms) {\n  setTimeout(fire, ms);\n  return [Date.now(), panel.offsetWidth, "h-9"];\n}`,
    ...Array.from(
      { length: LINKS },
      (_, index) =>
        `function h${index}(ms) {\n  h${index + 1}(ms);\n  return [h${index + 1}(ms), h${index + 1}(ms)];\n}`
    ),
    "function self(ms) {\n  setTimeout(fire, ms);\n  return [self(ms), Date.now()];\n}",
    "const later = (ms) => () => new Promise((r) => setTimeout(r, ms));",
    'function register(retry) {\n  it("r", { retry }, body);\n  register(retry);\n  register(register);\n}',
    "register(2);",
  ];
  const reads = [
    'it("x", () => {\n  vi.useFakeTimers();\n  h0(100);\n  self(100);\n  later(100)();\n});',
    "expect(h0(1)[0][0]).toBe(1);",
    "expect(self(1)).toBe(1);",
    "expect(button).toHaveClass(h0(1));",
    "expect(h0(1)).toBe(120);",
    'it("y", { retry: h0(1) }, () => {});',
    "readFileSync(h0(1));",
  ];
  return [...helpers, ...reads].join("\n");
}

describe("every recursive analysis is bounded", () => {
  it("reads values in every rule the plugin publishes", () => {
    expect(Object.keys(HOLES).sort()).toEqual(Object.keys(plugin.rules).sort());
  });

  it("finishes every rule on self-referencing and doubled values without a plugin error", () => {
    const root = mkdtempSync(join(tmpdir(), "traversal-guard-"));
    try {
      const rules = Object.fromEntries(Object.keys(HOLES).map((rule) => [`tests/${rule}`, "error"]));
      writeFileSync(
        join(root, ".oxlintrc.json"),
        JSON.stringify({
          jsPlugins: [{ name: "tests", specifier: join(packageRoot, "index.ts") }],
          categories: { correctness: "off" },
          rules,
        })
      );
      for (const [builder, build] of Object.entries(BUILDERS))
        for (const [rule, holes] of Object.entries(HOLES))
          writeFileSync(
            join(root, `${rule}-${builder.replaceAll(" ", "-")}.test.tsx`),
            builtFixture(build, holes)
          );
      writeFileSync(join(root, "helpers.test.tsx"), helperFixture());
      for (const [rule, holes] of Object.entries(HOLES))
        writeFileSync(join(root, `${rule}-member-chain.test.tsx`), memberChainFixture(holes));
      // A hang guard only: a bounded run finishes far inside it.
      const run = spawnSync(oxlint, ["-c", ".oxlintrc.json", "--format", "json", "."], {
        cwd: root,
        encoding: "utf8",
        timeout: 120_000,
      });
      // 0 is a clean run and 1 a run with lint errors; null is a signal or the hang guard's timeout.
      expect([0, 1]).toContain(run.status);
      // Each diagnostic is one JSON object; a plugin error is one whose message says so.
      const crashes = [...run.stdout.matchAll(/"message": "(Error running JS plugin[^"]*)"/gu)].map((match) =>
        (match[1] ?? "").split("\\n").slice(0, 4).join(" | ")
      );
      expect(run.stdout).toContain('"diagnostics"');
      expect(crashes).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
