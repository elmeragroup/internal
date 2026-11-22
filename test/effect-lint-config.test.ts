import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { asRecord, asRecordArray, asString, readJsonObject } from "../scripts/lib/json-object.mjs";

/*
 * The Effect diagnostics are configured twice: tooling/typescript/effect.json, the language-service preset the editor
 * reads, and .oxlintrc.effect.json, the rules `pnpm lint:effect` gates on through the Effect-patched oxlint. Stock oxlint
 * cannot parse a config naming the `effecttsgo` plugin, so the gate cannot live in .oxlintrc.json. These cases hold the
 * two configs to one decision per rule, and the gate to the main pass's scope and the catalog's compiler.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

/** Comments located by a JavaScript parser (JSONC is a JavaScript expression), so a `//` inside a string survives. */
function commentSpans(text: string): ReadonlyArray<{ readonly start: number; readonly end: number }> {
  const result = parseSync("config.js", `(${text})`);
  if (result.errors.length > 0) throw new Error(result.errors.map((error) => error.message).join("\n"));
  return result.comments.map(({ start, end }) => ({ start: start - 1, end: end - 1 }));
}

/** Parses a committed JSONC config: its comments become spaces, and the rest must be JSON. */
function parseJsonc(text: string, label: string) {
  let json = text;
  for (const { start, end } of commentSpans(text)) {
    json = json.slice(0, start) + " ".repeat(end - start) + json.slice(end);
  }
  // SAFETY: JSON.parse is untyped; asRecord is the contract.
  return asRecord(JSON.parse(json) as unknown, label);
}

/** The preset's `diagnosticSeverity` text, in source order, for the reasons its offs must carry. */
function severityBlock(text: string): string {
  const start = text.indexOf('"diagnosticSeverity"');
  return text.slice(start, text.indexOf("}", start));
}

const presetText = read("tooling/typescript/effect.json");
const preset = parseJsonc(presetText, "tooling/typescript/effect.json");
const [plugin] = asRecordArray(asRecord(preset.compilerOptions, "compilerOptions").plugins, "plugins");
const severities = Object.entries(asRecord(plugin?.diagnosticSeverity, "diagnosticSeverity"));
const gate = parseJsonc(read(".oxlintrc.effect.json"), ".oxlintrc.effect.json");

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

    // A comment explains the run of offs below it; an error entry ends the run.
    const unexplained: string[] = [];
    let explained = false;
    for (const line of severityBlock(presetText)
      .split("\n")
      .map((text) => text.trim())) {
      if (line.startsWith("//")) explained = true;
      if (line.endsWith('"error",') || line.endsWith('"error"')) explained = false;
      const off = /^"(?<rule>\w+)": "off",?$/u.exec(line)?.groups?.rule;
      if (off !== undefined && !explained) unexplained.push(off);
    }
    expect(unexplained).toEqual([]);
  });

  // effect-tsgo falls back silently to its newest packaged tsrs when the installed one is not supported, so the gate
  // names its tsrs, and that is the catalog's.
  it("lints with the catalog's tsrs", () => {
    const catalog = asRecord(asRecord(parse(read("pnpm-workspace.yaml")), "workspace").catalog, "catalog");
    const scripts = asRecord(readJsonObject(join(repoRoot, "package.json")).scripts, "scripts");

    expect(asString(scripts["lint:effect"], "lint:effect")).toContain(
      `effect-tsgo --tsrs-lint=${asString(catalog.tsrs, "tsrs")} oxlint `
    );
  });

  // The Effect pass lints the whole workspace, as the main pass does: a file that only consumes Effect values needs the
  // rules as much as one that imports effect. Both passes skip the same paths.
  it("ignores what the main pass ignores", () => {
    expect(gate.ignorePatterns).toEqual(readJsonObject(join(repoRoot, ".oxlintrc.json")).ignorePatterns);
  });
});
