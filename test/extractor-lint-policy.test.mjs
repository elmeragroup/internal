import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

import { asRecord, asRecordArray, isString, readJsonObject } from "../scripts/lib/json-object.mjs";

/*
 * The api-extractor lint policy in AGENTS.md: every disable names one rule on the next line and
 * gives a reason, no file-wide disable, and no path-wide override that relaxes a rule. Lint states
 * the disable contract itself through `elmera/require-disable-reason` in the api-extractor override.
 * This suite holds what a lint rule cannot state about the lint config and the disables as a whole.
 *
 * The config is judged per extractor file, as oxlint applies it: the base rules, then every
 * override whose `files` match the file and whose `excludeFiles` do not, in order, each rule
 * setting replacing the one before it whole (a bare severity drops the earlier options). `oxlint
 * --print-config` prints the merged config with its overrides unresolved, so it cannot answer for
 * one file. Globs are matched as oxlint's `GlobSet` matches them: a leading `./` is dropped, a glob
 * with no `/` (and no `./`) is prefixed with `**\/`, and the result goes to `fast_glob::glob_match`,
 * where a leading `!` negates the whole glob. Node's `path.matchesGlob` stands in for
 * `glob_match` on oxlint's grammar only: a glob using syntax outside it (an extglob, a POSIX
 * class) fails the policy rather than being guessed at. A differential fixture runs the oxlint CLI
 * on the same globs, as `files` and as `excludeFiles`, so drift shows up.
 *
 * oxlint has no switch that ignores inline disable directives, so a directive can silence the
 * disable guard itself: a blanket disable (no rule named), or one that names the guard. This suite
 * rejects every such directive in the extractor, reading comments with `oxc-parser` (tsrs's
 * scanner cannot tell a regular expression from a division without its parser, and its parser
 * offers no list of a file's comments).
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const extractorRoot = join(repoRoot, "packages", "api-extractor");
const lintConfig = readJsonObject(join(repoRoot, ".oxlintrc.json"));

/** The disable contract every api-extractor file is linted with. */
const STRICT_DISABLES = ["error", { directives: ["disable-next-line"], rules: "one" }];

/** The extensions oxlint lints. */
const LINTED = /\.(?:[cm]?[jt]sx?)$/u;

/**
 * @param {Record<string, unknown>} override
 * @param {"files" | "excludeFiles"} key
 * @returns {string[]}
 */
function globsOf(override, key) {
  const globs = override[key];
  if (globs === undefined && key === "excludeFiles") return [];
  if (!Array.isArray(globs)) throw new Error(`override.${key} is not an array`);
  return globs.filter((glob) => isString(glob));
}

/** Glob syntax Node's `path.matchesGlob` reads but oxlint's `fast_glob` does not: extglobs and POSIX classes. */
const OUTSIDE_OXLINT_GRAMMAR = /[@!+*?]\(|\[:/u;

/**
 * A glob as oxlint's `GlobSet::new` normalises it.
 *
 * @param {string} glob
 */
function normalised(glob) {
  const relative = glob.startsWith("./") ? glob.slice(2) : glob;
  return relative.includes("/") || relative !== glob ? relative : `**/${relative}`;
}

/**
 * Whether a glob matches a repo-relative file as oxlint matches an override glob.
 *
 * @param {string} file
 * @param {string} glob
 */
function matches(file, glob) {
  const pattern = normalised(glob);
  return pattern.startsWith("!") ? !matchesGlob(file, pattern.slice(1)) : matchesGlob(file, pattern);
}

/**
 * Whether an override applies to a repo-relative file.
 *
 * @param {Record<string, unknown>} override
 * @param {string} file
 */
function appliesTo(override, file) {
  return (
    globsOf(override, "files").some((glob) => matches(file, glob)) &&
    !globsOf(override, "excludeFiles").some((glob) => matches(file, glob))
  );
}

/**
 * A rule setting's severity: the string itself, or an array's first entry.
 *
 * @param {unknown} setting
 */
function severityOf(setting) {
  return Array.isArray(setting) ? /** @type {unknown} */ (setting[0]) : setting;
}

/**
 * Every way a config breaks the policy for a set of api-extractor files: an applicable override
 * that sets a rule to anything but `error`, and a file whose effective `elmera/require-disable-reason`
 * is not the strict contract.
 *
 * @param {Record<string, unknown>} config
 * @param {ReadonlyArray<string>} files - Repo-relative api-extractor files.
 * @returns {string[]}
 */
function policyBreaks(config, files) {
  const overrides = asRecordArray(config.overrides, "overrides");
  /** @type {Set<string>} */
  const breaks = new Set();
  // The matcher models oxlint's grammar only, so a glob outside it cannot be judged at all.
  for (const override of overrides) {
    for (const glob of [...globsOf(override, "files"), ...globsOf(override, "excludeFiles")]) {
      if (OUTSIDE_OXLINT_GRAMMAR.test(glob))
        breaks.add(
          `${glob}: glob syntax outside oxlint's grammar (extglob or POSIX class); oxlint does not read it as Node does`
        );
    }
  }
  for (const file of files) {
    let disables = asRecord(config.rules, "rules")["elmera/require-disable-reason"];
    for (const override of overrides.filter((candidate) => appliesTo(candidate, file))) {
      const where = globsOf(override, "files").join(", ");
      for (const [rule, setting] of Object.entries(asRecord(override.rules, "override.rules"))) {
        if (severityOf(setting) !== "error") breaks.add(`${where}: ${rule} is ${JSON.stringify(setting)}`);
        if (rule === "elmera/require-disable-reason") disables = setting;
      }
    }
    if (JSON.stringify(disables) !== JSON.stringify(STRICT_DISABLES))
      breaks.add(`${file}: elmera/require-disable-reason is ${JSON.stringify(disables)}`);
  }
  return [...breaks].sort();
}

/** Every file under packages/api-extractor that lint reads, repo-relative. */
const extractorFiles = readdirSync(extractorRoot, { recursive: true, encoding: "utf8" })
  .filter((file) => LINTED.test(file) && !/(?:^|\/)(?:node_modules|dist|test\/fixtures)\//u.test(file))
  .map((file) => `packages/api-extractor/${file}`);

/** Each api-extractor file's text, for the checks only the text can answer (its comments). */
const extractorSources = extractorFiles.map((file) => ({
  file,
  // oxlint-disable-next-line tests/no-source-reading-tests -- disable directives and their counts live only in the source text
  text: readFileSync(join(repoRoot, file), "utf8"),
}));

/** A disable directive at the start of a comment's body, and what follows it. */
const DIRECTIVE = /^\s*(?:eslint|oxlint)-disable(?:-next-line|-line)?(?![\w-])([\s\S]*)$/u;

/**
 * Every comment in a JavaScript or TypeScript text, whole: its source (`//…` or `/*…*\/`) and its
 * body, as `oxc-parser` (the parser family oxlint reads directives with) finds them. A text that
 * does not parse yields `undefined`, which the caller reports, since its comments are not known.
 *
 * @param {string} text
 * @param {string} filename - Decides the dialect: TypeScript, JSX, or both.
 * @returns {Array<{ source: string, body: string }> | undefined}
 */
function commentsIn(text, filename) {
  const parsed = parseSync(filename, text);
  if (parsed.errors.length > 0) return undefined;
  return parsed.comments.map((comment) => ({
    source: text.slice(comment.start, comment.end),
    body: comment.value,
  }));
}

/**
 * Every disable directive in a text that can silence the disable guard: one that names no rule
 * (a blanket disable, whose reports it hides along with every other rule's), or one that names
 * `elmera/require-disable-reason`. Each comment is read whole, so a rule list may span lines.
 *
 * @param {string} text
 * @param {string} [filename]
 * @returns {string[]}
 */
function guardSilencers(text, filename = "fixture.tsx") {
  const comments = commentsIn(text, filename);
  if (comments === undefined) return [`${filename}: does not parse, so its directives are unknown`];
  return comments.flatMap(({ source, body }) => {
    const directive = DIRECTIVE.exec(body);
    if (directive === null) return [];
    const named = directive[1].split("--")[0] ?? "";
    const rules = named.split(/[\s,]+/u).filter((rule) => rule !== "");
    const silences = rules.length === 0 || rules.includes("elmera/require-disable-reason");
    return silences ? [source] : [];
  });
}

/**
 * The repo's config with more overrides after its own.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} extra
 */
function withOverrides(extra) {
  return { ...lintConfig, overrides: [...asRecordArray(lintConfig.overrides, "overrides"), ...extra] };
}

describe("api-extractor lint policy", () => {
  it("lints every api-extractor file with the strict disable contract and relaxes no rule", () => {
    expect(extractorFiles.length).toBeGreaterThan(50);
    expect(policyBreaks(lintConfig, extractorFiles)).toEqual([]);
  });

  it("matches override globs per file, so a wildcard or brace glob cannot relax a rule unseen", () => {
    const wildcard = withOverrides([{ files: ["packages/*/src/**"], rules: { "no-debugger": "off" } }]);
    expect(policyBreaks(wildcard, extractorFiles)).toEqual(['packages/*/src/**: no-debugger is "off"']);
    const braces = withOverrides([
      { files: ["packages/{api-extractor,release}/**"], rules: { "no-debugger": "warn" } },
    ]);
    expect(policyBreaks(braces, extractorFiles)).toEqual([
      'packages/{api-extractor,release}/**: no-debugger is "warn"',
    ]);
    // An override whose `excludeFiles` covers the package does not apply to it.
    const excluded = withOverrides([
      {
        files: ["packages/**"],
        excludeFiles: ["packages/api-extractor/**"],
        rules: { "no-debugger": "off" },
      },
    ]);
    expect(policyBreaks(excluded, extractorFiles)).toEqual([]);
  });

  it("follows a later override that resets the disable contract to its permissive defaults", () => {
    const reset = withOverrides([
      { files: ["packages/api-extractor/src/parse/**"], rules: { "elmera/require-disable-reason": "error" } },
    ]);
    const breaks = policyBreaks(reset, extractorFiles);
    expect(breaks.length).toBeGreaterThan(0);
    expect(breaks.every((entry) => entry.startsWith("packages/api-extractor/src/parse/"))).toBe(true);
    expect(breaks.every((entry) => entry.endsWith('elmera/require-disable-reason is "error"'))).toBe(true);
  });

  it("matches override and exclude globs as the oxlint CLI does", () => {
    /** Files of every shape the extractor policy cares about, each with a `debugger` to report. */
    const fixture = [
      "packages/api-extractor/src/a.ts",
      "packages/api-extractor/b.ts",
      "packages/api-extractor/test/f.test.ts",
      "packages/release/src/c.ts",
      "src/d.ts",
      "e.ts",
    ];
    const globs = [
      "./packages/api-extractor/**",
      "!packages/release/**",
      "packages/*/src/**",
      "packages/{api-extractor,release}/**",
      "*.ts",
      "!*.test.ts",
      "./e.ts",
      "**/test/**",
    ];
    const root = mkdtempSync(join(tmpdir(), "oxlint-globs-"));
    try {
      for (const file of fixture) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), "debugger;\n");
      }
      const oxlint = join(repoRoot, "node_modules", ".bin", "oxlint");
      /** The fixture files oxlint reports `debugger` in under one override. */
      const lintedUnder = (/** @type {Record<string, unknown>} */ override) => {
        const config = {
          categories: { correctness: "off" },
          rules: { "no-debugger": "off" },
          overrides: [{ ...override, rules: { "no-debugger": "error" } }],
        };
        writeFileSync(join(root, ".oxlintrc.json"), JSON.stringify(config));
        const run = spawnSync(oxlint, ["-c", ".oxlintrc.json", "--format", "json", "."], {
          cwd: root,
          encoding: "utf8",
        });
        const report = asRecord(JSON.parse(run.stdout), "oxlint report");
        const linted = asRecordArray(report.diagnostics, "diagnostics").map((diagnostic) =>
          String(diagnostic.filename)
        );
        return [...new Set(linted)].sort();
      };
      for (const glob of globs) {
        expect({ glob, files: fixture.filter((file) => matches(file, glob)).sort() }).toEqual({
          glob,
          files: lintedUnder({ files: [glob] }),
        });
        expect({ excluded: glob, files: fixture.filter((file) => !matches(file, glob)).sort() }).toEqual({
          excluded: glob,
          files: lintedUnder({ files: ["**"], excludeFiles: [glob] }),
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches the globs oxlint normalises or negates, so neither can relax a rule unseen", () => {
    const dotted = withOverrides([
      { files: ["./packages/api-extractor/**"], rules: { "no-debugger": "off" } },
    ]);
    expect(policyBreaks(dotted, extractorFiles)).toEqual([
      './packages/api-extractor/**: no-debugger is "off"',
    ]);
    const negated = withOverrides([{ files: ["!packages/release/**"], rules: { "no-debugger": "off" } }]);
    expect(policyBreaks(negated, extractorFiles)).toEqual(['!packages/release/**: no-debugger is "off"']);
  });

  it("has no disable directive in api-extractor that could silence the disable guard", () => {
    const silencers = extractorSources.flatMap(({ file, text }) =>
      guardSilencers(text, file).map((directive) => `${file}: ${directive}`)
    );
    expect(silencers).toEqual([]);
  });

  it("finds every directive shape that can silence the disable guard", () => {
    expect(
      guardSilencers(
        [
          "/* oxlint-disable */",
          "// eslint-disable-next-line",
          "debugger; // oxlint-disable-line",
          "/* oxlint-disable elmera/require-disable-reason -- quiet */",
          "// oxlint-disable-next-line no-debugger, elmera/require-disable-reason -- quiet",
          "// oxlint-disable-next-line no-debugger -- names one rule",
          "/* oxlint-disable-next-line no-debugger -- in a block */",
          "// oxlint-enable",
        ].join("\n")
      )
    ).toEqual([
      "/* oxlint-disable */",
      "// eslint-disable-next-line",
      "// oxlint-disable-line",
      "/* oxlint-disable elmera/require-disable-reason -- quiet */",
      "// oxlint-disable-next-line no-debugger, elmera/require-disable-reason -- quiet",
    ]);
  });

  it("reads a directive's whole comment, across lines and past strings that look like comments", () => {
    expect(
      guardSilencers(
        [
          "/* oxlint-disable no-debugger,",
          "   elmera/require-disable-reason -- probe */",
          'const text = "// oxlint-disable";',
          "const pattern = /\\/\\/ oxlint-disable/u;",
          "const ratio = total / 2; // oxlint-disable-line no-debugger -- names one rule",
          "const later = `${a} // oxlint-disable ${b}`;",
        ].join("\n")
      )
    ).toEqual(["/* oxlint-disable no-debugger,\n   elmera/require-disable-reason -- probe */"]);
  });

  it("finds a blanket disable after a regular expression that follows a condition", () => {
    expect(guardSilencers('if (ready) /"/.test(text);\n/* oxlint-disable */\ndebugger;')).toEqual([
      "/* oxlint-disable */",
    ]);
  });

  it("finds a guard-naming disable after a division of an incremented value", () => {
    expect(
      guardSilencers(
        "const half = index++ / 2; /* oxlint-disable elmera/require-disable-reason -- probe */ debugger;"
      )
    ).toEqual(["/* oxlint-disable elmera/require-disable-reason -- probe */"]);
  });

  it("fails on glob syntax outside oxlint's grammar, which Node would read differently", () => {
    const extglob = withOverrides([
      {
        files: ["packages/**"],
        excludeFiles: ["packages/@(api-extractor|release)/**"],
        rules: { "no-debugger": "off" },
      },
    ]);
    expect(policyBreaks(extglob, extractorFiles)).toContain(
      "packages/@(api-extractor|release)/**: glob syntax outside oxlint's grammar (extglob or POSIX class); oxlint does not read it as Node does"
    );
  });

  it("keeps next-line disables at or under the per-rule ceiling", () => {
    /** Empty-object-spread sprawl is gone; this is the current max so the count cannot regrow. */
    const ceiling = 17;
    /** @type {Map<string, number>} */
    const counts = new Map();
    const sources = extractorSources.filter(({ file }) => file.endsWith(".ts") || file.endsWith(".tsx"));
    expect(sources.length).toBeGreaterThan(50);
    for (const { text } of sources) {
      for (const match of text.matchAll(/oxlint-disable-next-line\s+(\S+)/gu)) {
        counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
      }
    }
    const offenders = [...counts.entries()]
      .filter(([, count]) => count > ceiling)
      .map(([rule, count]) => `${rule}: ${count}`)
      .sort();
    expect(offenders).toEqual([]);
    expect(counts.get("anti-slop/no-conditional-empty-object-spread") ?? 0).toBe(0);
  });
});
