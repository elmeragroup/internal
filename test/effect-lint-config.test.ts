import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
 * two configs to one decision per rule, and the gate to the main pass's scope and the catalog's compiler.
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

/**
 * The preset's `off` rules no comment explains. A comment explains the run of offs that follows it: it starts on a line
 * after the last `error` entry (or the object's opening brace) and ends before the off it explains. Reasons are read from
 * the parsed object's spans and the parser's comment tokens, so a brace or a block comment in a reason changes nothing.
 */
function unexplainedOffs(text: string): ReadonlyArray<string> {
  const { root, comments } = parseJsoncSyntax(text);
  const plugins = propertyValue(propertyValue(root, "compilerOptions"), "plugins");
  const plugin = plugins?.type === "ArrayExpression" ? plugins.elements[0] : undefined;
  const severity =
    plugin?.type === "ObjectExpression" ? propertyValue(plugin, "diagnosticSeverity") : undefined;
  if (severity?.type !== "ObjectExpression") throw new Error("the preset has no diagnosticSeverity object");
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
    const explained = comments.some(
      (comment) => lineOf(comment.start) > lineOf(boundary) && comment.end <= property.start
    );
    if (!explained) unexplained.push(String(property.key.value));
  }
  return unexplained;
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

  // An override could turn an error off for some paths while the list above still matches the preset, so the gate
  // takes none: its errors hold for every file it lints, as the preset's do.
  it("applies its errors to every file, with no override", () => {
    expect(Object.keys(gate)).not.toContain("overrides");
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
