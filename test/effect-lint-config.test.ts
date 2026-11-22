import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import type { Comment, Expression } from "oxc-parser";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { asRecord, asRecordArray, asString, readJsonObject } from "../scripts/lib/json-object.mjs";

/*
 * The Effect diagnostics are configured twice: tooling/typescript/effect.json, the language-service preset the editor
 * reads, and .oxlintrc.effect.json, the rules `pnpm lint:effect` gates on through the Effect-patched oxlint. Stock oxlint
 * cannot parse a config naming the `effecttsgo` plugin, so the gate cannot live in .oxlintrc.json. These cases hold the
 * two configs to one decision per rule, and the gate to the main pass's scope and the catalog's compiler. Every key of
 * either config that can change which rules run, where, or at what severity is pinned here: the gate's `extends`,
 * `overrides`, `plugins`, `categories`, `options` and `rules`, and the language-service entry's own keys.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

/** A JSONC config's expression and its comments, with spans that are offsets into the config's own text. */
type JsoncSyntax = { readonly root: Expression; readonly comments: ReadonlyArray<Comment> };

/**
 * A committed JSONC config parsed as the JavaScript expression it is, so a `//` inside a string stays a string.
 */
function parseJsoncSyntax(text: string): JsoncSyntax {
  const result = parseSync("config.js", `(${text})`, { preserveParens: false });
  if (result.errors.length > 0) throw new Error(result.errors.map((error) => error.message).join("\n"));
  const [statement] = result.program.body;
  if (statement?.type !== "ExpressionStatement") throw new Error("the config is not one expression");
  const shift = <T extends { readonly start: number; readonly end: number }>(node: T): T => ({
    ...node,
    start: node.start - 1,
    end: node.end - 1,
  });
  return { root: statement.expression, comments: result.comments.map((comment) => shift(comment)) };
}

/** Parses a committed JSONC config: its comments become spaces, and the rest must be JSON. */
function parseJsonc(text: string, label: string) {
  let json = text;
  for (const { start, end } of parseJsoncSyntax(text).comments) {
    json = json.slice(0, start) + " ".repeat(end - start) + json.slice(end);
  }
  // SAFETY: JSON.parse is untyped; asRecord is the contract.
  return asRecord(JSON.parse(json) as unknown, label);
}

/** The language-service plugin's name in a tsconfig's `compilerOptions.plugins`. */
const LANGUAGE_SERVICE = "@effect/language-service";

/** The value of an object literal's property with a string key, if it has one. */
function propertyValue(object: Expression | undefined, name: string): Expression | undefined {
  if (object?.type !== "ObjectExpression") return undefined;
  for (const property of object.properties) {
    if (property.type === "Property" && property.key.type === "Literal" && property.key.value === name) {
      return property.value;
    }
  }
  return undefined;
}

/** The language-service entry of a tsconfig's plugin list, found by name; anything but exactly one is an error. */
function languageServiceSyntax(root: Expression): Expression {
  const plugins = propertyValue(propertyValue(root, "compilerOptions"), "plugins");
  const entries =
    plugins?.type === "ArrayExpression"
      ? plugins.elements.filter((element) => {
          const name = element?.type === "ObjectExpression" ? propertyValue(element, "name") : undefined;
          return name?.type === "Literal" && name.value === LANGUAGE_SERVICE;
        })
      : [];
  const [entry, ...others] = entries;
  if (entry === null || entry === undefined || entry.type === "SpreadElement" || others.length > 0) {
    throw new Error(`the preset needs exactly one ${LANGUAGE_SERVICE} plugin entry`);
  }
  return entry;
}

/**
 * The preset's `off` rules no comment explains. A comment explains the run of offs that follows it: it starts on a line
 * after the last `error` entry (or the object's opening brace), ends before the off it explains, and says something once
 * its whitespace and block-comment stars are gone. Reasons are read from the parsed object's spans and the parser's
 * comment tokens, so a brace or a block comment in a reason changes nothing.
 */
function unexplainedOffs(text: string): ReadonlyArray<string> {
  const { root, comments } = parseJsoncSyntax(text);
  const severity = propertyValue(languageServiceSyntax(root), "diagnosticSeverity");
  if (severity?.type !== "ObjectExpression") throw new Error("the preset has no diagnosticSeverity object");
  const reasons = comments.filter((comment) => comment.value.replace(/[\s*]/gu, "").length > 0);
  const lineOf = (offset: number) => text.slice(0, offset).split("\n").length;
  const unexplained: string[] = [];
  let boundary = severity.start;
  for (const property of severity.properties) {
    if (
      property.type !== "Property" ||
      property.key.type !== "Literal" ||
      property.value.type !== "Literal"
    ) {
      throw new Error("diagnosticSeverity holds a non-literal entry");
    }
    if (property.value.value !== "off") {
      boundary = property.end;
      continue;
    }
    const explained = reasons.some(
      (comment) => lineOf(comment.start) > lineOf(boundary) && comment.end <= property.start
    );
    if (!explained) unexplained.push(String(property.key.value));
  }
  return unexplained;
}

const presetText = read("tooling/typescript/effect.json");
const preset = parseJsonc(presetText, "tooling/typescript/effect.json");
const languageService = asRecordArray(
  asRecord(preset.compilerOptions, "compilerOptions").plugins,
  "plugins"
).filter((entry) => entry.name === LANGUAGE_SERVICE);
const [plugin] = languageService;
if (plugin === undefined || languageService.length > 1) {
  throw new Error(`tooling/typescript/effect.json needs exactly one ${LANGUAGE_SERVICE} plugin entry`);
}
const severities = Object.entries(asRecord(plugin.diagnosticSeverity, "diagnosticSeverity"));
const gate = parseJsonc(read(".oxlintrc.effect.json"), ".oxlintrc.effect.json");
const tsrs = asString(
  asRecord(asRecord(parse(read("pnpm-workspace.yaml")), "workspace").catalog, "catalog").tsrs,
  "tsrs"
);

/**
 * A tsconfig's `extends` targets, resolved to repository paths: a workspace preset, or a path beside the file. A small
 * walker over the repository's own two specifier shapes, not the compiler's resolver: the root test project reads no
 * `tsrs/*` API, and these configs extend nothing else.
 */
function extendsOf(path: string): ReadonlyArray<string> {
  const config = parseJsonc(read(path), path);
  const targets = Array.isArray(config.extends)
    ? config.extends
    : config.extends === undefined
      ? []
      : [config.extends];
  return targets.map((target) => {
    const name = asString(target, `${path} extends`);
    const literal = name.startsWith("@elmeragroup/typescript-config/")
      ? join("tooling/typescript", name.slice("@elmeragroup/typescript-config/".length))
      : join(dirname(path), name);
    // As tsc and tsrs resolve `extends`: the path as written, else with `.json` appended when it lacks the extension.
    return existsSync(join(repoRoot, literal)) || literal.endsWith(".json") ? literal : `${literal}.json`;
  });
}

/** Every config a tsconfig reads through `extends`, itself first. */
function extendsChain(path: string): ReadonlyArray<string> {
  return [path, ...extendsOf(path).flatMap((target) => extendsChain(target))];
}

/** The hang guard of listing the committed tsconfigs, which takes milliseconds. */
const GIT_TIMEOUT_MS = 30_000;

/** The hang guard of one patched-oxlint run: it lints one file in well under a second. */
const PATCHED_OXLINT_TIMEOUT_MS = 60_000;

/** Code-unit order, for comparing two lists of rule names as sets that keep their duplicates. */
function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The oxlint name of a language-service rule, as each rule's docs list both: kebab case under `effecttsgo/`. */
function oxlintName(rule: string): string {
  return `effecttsgo/${rule.replace("UUID", "Uuid").replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;
}

describe("Effect diagnostics", () => {
  it("gates exactly the preset's errors, as errors", () => {
    const errors = severities.filter(([, level]) => level === "error").map(([rule]) => oxlintName(rule));
    const rules = Object.entries(asRecord(gate.rules, "rules"));

    expect(rules.map(([rule]) => rule).sort(byCodeUnit)).toEqual(errors.sort(byCodeUnit));
    expect(new Set(rules.map(([, level]) => level))).toEqual(new Set(["error"]));
  });

  // The rule list above is all the gate may say about rules. `extends` and `overrides` could relax a rule for some
  // paths, and without type-aware mode, the effecttsgo plugin or the correctness category off, it would run a different
  // set; a key not listed here is a new decision this test makes someone take.
  it("is self-contained, applies its errors to every file, and runs only its own rules", () => {
    expect(Object.keys(gate).sort(byCodeUnit)).toEqual(
      ["$schema", "categories", "ignorePatterns", "options", "plugins", "rules"].sort(byCodeUnit)
    );
    expect(gate.plugins).toEqual(["effecttsgo"]);
    expect(gate.categories).toEqual({ correctness: "off" });
    expect(gate.options).toEqual({ typeAware: true });
  });

  // The patched oxlint's own report, the oracle the config keys above only predict: it activates every rule the gate
  // lists. A config that parses but activates none (type-aware mode off, say) reports 0.
  it(
    "activates every rule it lists in the patched oxlint",
    () => {
      const run = spawnSync(
        join(repoRoot, "node_modules", ".bin", "effect-tsgo"),
        [
          `--tsrs-lint=${tsrs}`,
          "oxlint",
          "-c",
          ".oxlintrc.effect.json",
          "--format=json",
          "test/effect-lint-config.test.ts",
        ],
        { cwd: repoRoot, encoding: "utf8", timeout: PATCHED_OXLINT_TIMEOUT_MS }
      );
      if (run.error !== undefined) throw run.error;
      // SAFETY: JSON.parse is untyped; asRecord is the contract, and a missing count fails the comparison.
      const report = asRecord(JSON.parse(run.stdout) as unknown, "patched oxlint report");

      expect(report.number_of_rules).toBe(Object.keys(asRecord(gate.rules, "rules")).length);
    },
    PATCHED_OXLINT_TIMEOUT_MS
  );

  // The editor and the gate read the same decisions only while the preset's one language-service entry holds them all:
  // its own `overrides`, `diagnostics: false` or an exit-code switch would change the editor's rules and not CI's.
  it("keeps every decision in the one language-service entry's severities", () => {
    expect(Object.keys(plugin).sort(byCodeUnit)).toEqual(
      [
        "allowedUnstableApis",
        "diagnosticSeverity",
        "effectFn",
        "includeSuggestionsInTsc",
        "name",
        "namespaceImportPackages",
      ].sort(byCodeUnit)
    );
  });

  // The rules read their options (namespace imports, the unstable allowlist) from each linted file's tsconfig. A tsconfig
  // that misses the preset, or declares a plugin list of its own (which replaces the preset's), lints its files with
  // the defaults instead and drops the editor's diagnostics there.
  it("reaches the preset from every linted tsconfig, and no tsconfig replaces its plugin list", () => {
    // The committed tsconfigs, the set CI lints. Listing untracked files too walks the whole tree, seconds on a busy
    // disk, for files the gate sees only once they are committed.
    const listed = spawnSync("git", ["ls-files", "--cached", "*tsconfig*.json"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    });
    if (listed.error !== undefined) throw listed.error;
    const ignored = Array.isArray(gate.ignorePatterns)
      ? gate.ignorePatterns.map((pattern) => asString(pattern, "ignore pattern"))
      : [];
    const linted = listed.stdout
      .split("\n")
      .filter((path) => path.length > 0)
      .filter((path) => !ignored.some((pattern) => matchesGlob(path, pattern)));
    const preset = "tooling/typescript/effect.json";
    const findings = linted.flatMap((path) => {
      const chain = extendsChain(path);
      const replacing = chain.filter((config) => {
        const options = parseJsonc(read(config), config).compilerOptions;
        return (
          config !== preset && options !== undefined && "plugins" in asRecord(options, "compilerOptions")
        );
      });
      return [
        ...(chain.includes(preset) ? [] : [`${path}: does not reach ${preset}`]),
        ...replacing.map((config) => `${path}: ${config} declares its own plugins`),
      ];
    });

    expect(linted.length).toBeGreaterThan(0);
    expect(findings).toEqual([]);
  });

  // A bump of @effect/tsgo that adds a rule fails here until the preset decides it; oxlint runs only the rules the gate
  // names, so an undecided rule would otherwise go unchecked without a word. A deprecated rule stays unnamed, since
  // naming one, even off, makes the patched compiler warn.
  it("decides every current rule of the installed @effect/tsgo: an error, or off with its reason", () => {
    const schema = readJsonObject(join(repoRoot, "node_modules/@effect/tsgo/schema.json"));
    const rules = asRecord(
      asRecord(
        asRecord(schema.definitions, "definitions").effectLanguageServicePluginDiagnosticSeverityDefinition,
        "severity definition"
      ).properties,
      "severity properties"
    );
    const current = Object.entries(rules)
      .filter(
        ([, rule]) => !asString(asRecord(rule, "rule").description, "description").startsWith("Deprecated")
      )
      .map(([name]) => name);

    expect(severities.map(([rule]) => rule).sort(byCodeUnit)).toEqual(current.sort(byCodeUnit));
    expect(severities.filter(([, level]) => level !== "error" && level !== "off")).toEqual([]);

    expect(unexplainedOffs(presetText)).toEqual([]);
  });

  // effect-tsgo falls back silently to its newest packaged tsrs when the installed one is not supported, so the gate
  // names its tsrs, and that is the catalog's.
  it("lints with the catalog's tsrs", () => {
    const scripts = asRecord(readJsonObject(join(repoRoot, "package.json")).scripts, "scripts");

    expect(asString(scripts["lint:effect"], "lint:effect")).toContain(
      `effect-tsgo --tsrs-lint=${tsrs} oxlint `
    );
  });

  // The Effect pass lints the whole workspace, as the main pass does: a file that only consumes Effect values needs the
  // rules as much as one that imports effect. Both passes skip the same paths.
  it("ignores what the main pass ignores", () => {
    expect(gate.ignorePatterns).toEqual(readJsonObject(join(repoRoot, ".oxlintrc.json")).ignorePatterns);
  });
});
