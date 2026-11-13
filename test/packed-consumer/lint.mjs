import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const root = process.cwd();
await writeFile(
  "reject-compiler.mjs",
  `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (/^(?:effect|typescript|tsrs|undici)(?:\\/|$)/.test(specifier)) throw new Error("Unexpected runtime import: " + specifier);
  return nextResolve(specifier, context);
}});
`
);
await writeFile(
  "check-entries.mjs",
  `import assert from "node:assert/strict";
const model = await import("@elmeragroup/internal/api-artifacts/model");
assert.deepEqual(Object.keys(model), []);
const { default: elmera } = await import("@elmeragroup/internal/oxlint");
const { default: antiSlop } = await import("@elmeragroup/internal/oxlint/anti-slop");
const { default: tests } = await import("@elmeragroup/internal/oxlint/tests");
assert.ok(elmera.rules["no-tailwind-dark-variant"]);
assert.ok(elmera.rules["require-disable-reason"]);
assert.ok(antiSlop.rules["no-reflect-get"]);
assert.equal(tests.meta.name, "tests");
assert.deepEqual(Object.keys(tests.rules).sort(), [
  "no-class-assertions",
  "no-fixed-delay",
  "no-geometry-assertions",
  "no-source-reading-tests",
  "no-test-retry",
  "no-wall-clock",
]);
`
);
execFileSync(
  process.execPath,
  ["--no-experimental-strip-types", "--import", "./reject-compiler.mjs", "check-entries.mjs"],
  { stdio: "inherit" }
);
await writeFile(
  ".oxlintrc.json",
  JSON.stringify({
    jsPlugins: [
      { name: "elmera", specifier: "@elmeragroup/internal/oxlint" },
      { name: "anti-slop", specifier: "@elmeragroup/internal/oxlint/anti-slop" },
      { name: "tests", specifier: "@elmeragroup/internal/oxlint/tests" },
    ],
    rules: {
      "elmera/no-tailwind-dark-variant": "error",
      "elmera/require-disable-reason": "error",
      "anti-slop/no-reflect-get": "error",
    },
    overrides: [
      {
        files: ["**/*.test.ts"],
        rules: {
          "tests/no-fixed-delay": ["error", { waitHelpers: ["pause"] }],
          "tests/no-wall-clock": "error",
        },
      },
    ],
  })
);
await writeFile(
  "lint-input.ts",
  'export const classes = "dark:bg-red-500";\nexport const value = Reflect.get({}, "key");\n' +
    "// oxlint-disable-next-line no-debugger\ndebugger;\n"
);
await writeFile(
  "lint-input.test.ts",
  [
    'it("settles", async () => {',
    "  await pause(250);",
    "  const start = Date.now();",
    "  expect(Date.now() - start).toBeLessThan(1000);",
    "});",
    'it("ticks", () => {',
    "  vi.useFakeTimers();",
    "  const start = Date.now();",
    "  setTimeout(tick, 250);",
    "  expect(Date.now() - start).toBe(0);",
    "});",
    "",
  ].join("\n")
);
const oxlint = path.join(path.dirname(require.resolve("oxlint/package.json")), "bin/oxlint");
const lint = spawnSync(
  oxlint,
  ["--config", ".oxlintrc.json", "--format=json", "lint-input.ts", "lint-input.test.ts"],
  {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: `--no-experimental-strip-types --import=${path.join(root, "reject-compiler.mjs")}`,
    },
  }
);
assert.equal(lint.status, 1, lint.stdout + lint.stderr);
assert.match(lint.stdout + lint.stderr, /no-tailwind-dark-variant/);
assert.match(lint.stdout + lint.stderr, /no-reflect-get/);
assert.match(lint.stdout + lint.stderr, /require-disable-reason/);
// The consumer's configured wait helper and wall-clock budget fire once each, in the real-clock
// test only; the faked test stays clean.
// SAFETY: oxlint's JSON reporter prints this shape; the deep equality below checks what it needs.
const { diagnostics } =
  /** @type {{ diagnostics: Array<{ code: string, filename: string, labels: Array<{ span: { line: number } }> }> }} */ (
    JSON.parse(lint.stdout)
  );
assert.deepEqual(
  diagnostics
    .filter((diagnostic) => diagnostic.filename === "lint-input.test.ts")
    .map((diagnostic) => `${diagnostic.labels[0]?.span.line}: ${diagnostic.code}`)
    .sort(),
  ["2: tests(no-fixed-delay)", "4: tests(no-wall-clock)"]
);
assert.doesNotMatch(lint.stdout + lint.stderr, /Unexpected runtime import/);
