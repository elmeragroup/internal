import { defineRule } from "@oxlint/plugins";

/** @import { Context } from "@oxlint/plugins" */

/** @typedef {"disable" | "disable-line" | "disable-next-line"} DirectiveKind */

/**
 * @typedef {object} Options
 * @property {ReadonlyArray<DirectiveKind>} directives - The directive kinds a comment may use.
 * @property {"any" | "one"} rules - Whether a directive may name several rules or exactly one.
 */

/**
 * A disable directive at the start of a comment, in both spellings oxlint honours, with its kind.
 * `oxlint-disable` without a suffix silences the rest of the file, or up to an `oxlint-enable`.
 */
const DIRECTIVE = /^\s*(?:oxlint|eslint)-(disable(?:-next-line|-line)?)(?=\s|$)/u;

/**
 * An Effect language-service directive, as `@effect/tsgo` reads it: anywhere on a line, the
 * section form (`@effect-diagnostics`, from here on) or the next-line form, then whitespace-separated
 * tokens. It is the upstream pattern (`internal/directives/parser.go`), with RE2's ASCII classes.
 */
const EFFECT_DIRECTIVE =
  /@effect-diagnostics(-next-line)?[\t\n\f\r ]+([0-9A-Za-z_:\-*]+(?:[\t\n\f\r ]+[0-9A-Za-z_:\-*]+)*)/u;

/**
 * The `rule:severity` pairs `@effect/tsgo` reads from a directive's tokens, a reason's words among
 * them, so a pair written in a reason counts as a rule the directive names.
 */
const EFFECT_RULE_SEVERITY = /([0-9A-Za-z_]+|\*):([0-9A-Za-z_]+(?:-[0-9A-Za-z_]+)?)/gu;

/**
 * The severities below `error`, as `@effect/tsgo` spells them (`etscore/severity.go`, case-blind).
 * Each relaxes a rule below the error a gate configures; `@effect/tsgo` reads any other word as `error`.
 */
const EFFECT_RELAXING = new Set(["off", "skip-file", "warning", "warn", "suggestion", "message"]);

/** The separator between a directive's rules and its reason. */
const SEPARATOR = " -- ";

/** Non-space characters a reason must carry, so it says more than "needed". */
const MINIMUM_REASON = 8;

/** @type {ReadonlyArray<DirectiveKind>} */
const DIRECTIVE_KINDS = ["disable", "disable-line", "disable-next-line"];

/** @type {Options} */
const DEFAULT_OPTIONS = { directives: DIRECTIVE_KINDS, rules: "any" };

/**
 * @param {string} kind
 * @returns {kind is DirectiveKind}
 */
function isDirectiveKind(kind) {
  return DIRECTIVE_KINDS.some((known) => known === kind);
}

/**
 * The configured options over the defaults. Oxlint validates the configured object against the
 * rule's schema first, so each key is either absent or of its schema's shape.
 *
 * @param {Context} context
 * @returns {Options}
 */
function optionsOf(context) {
  const [configured] = context.options;
  if (configured === null || typeof configured !== "object" || Array.isArray(configured)) {
    return DEFAULT_OPTIONS;
  }
  const directives = Array.isArray(configured.directives)
    ? configured.directives.filter((kind) => typeof kind === "string" && isDirectiveKind(kind))
    : DEFAULT_OPTIONS.directives;
  const rules = configured.rules === "one" ? "one" : DEFAULT_OPTIONS.rules;
  return { directives, rules };
}

/**
 * One directive found in a comment, in either family, as the policy checks it.
 *
 * @typedef {object} Directive
 * @property {string} directive - The directive as written, for messages.
 * @property {DirectiveKind} kind - Its scope: `disable-next-line` for a next-line directive, `disable`
 *   for one that holds to the end of the file or of its section.
 * @property {(kind: DirectiveKind) => string} spell - How its family writes a directive of a kind.
 * @property {ReadonlyArray<string>} rules - The rules it names; `*` names every rule.
 * @property {string} reason - The text after its ` -- ` separator.
 */

/**
 * The oxlint or eslint disable directive at the start of a comment.
 *
 * @param {string} text - The comment's text.
 * @returns {Directive | undefined}
 */
function oxlintDirective(text) {
  const match = DIRECTIVE.exec(text);
  const kind = match?.[1];
  if (match === null || kind === undefined || !isDirectiveKind(kind)) return undefined;
  const rest = text.slice(match[0].length);
  const separator = rest.indexOf(SEPARATOR);
  return {
    directive: match[0].trim(),
    kind,
    spell: (allowed) => `oxlint-${allowed}`,
    rules: namedRules(separator === -1 ? rest : rest.slice(0, separator)),
    reason: separator === -1 ? "" : rest.slice(separator + SEPARATOR.length),
  };
}

/**
 * How `@effect/tsgo` writes a directive of a kind; it has no same-line form, so that one is spelled
 * as the next-line form a caller can move it to.
 *
 * @param {DirectiveKind} kind
 * @returns {string}
 */
function spellEffect(kind) {
  return kind === "disable" ? "@effect-diagnostics" : "@effect-diagnostics-next-line";
}

/**
 * The Effect directives in a comment that relax a rule, one per line as `@effect/tsgo` reads them.
 * A directive that only raises rules to errors needs no reason.
 *
 * @param {string} text - The comment's text.
 * @returns {Directive[]}
 */
function effectDirectives(text) {
  return text.split("\n").flatMap((line) => {
    const match = EFFECT_DIRECTIVE.exec(line);
    const tokens = match?.[2];
    if (match === null || tokens === undefined) return [];
    const pairs = [...tokens.matchAll(EFFECT_RULE_SEVERITY)];
    const relaxes = pairs.some(([, , severity]) => EFFECT_RELAXING.has(severity?.toLowerCase() ?? ""));
    if (!relaxes) return [];
    const rest = line.slice(match.index);
    const separator = rest.indexOf(SEPARATOR);
    return [
      {
        directive: `@effect-diagnostics${match[1] ?? ""}`,
        kind: match[1] === undefined ? "disable" : "disable-next-line",
        spell: spellEffect,
        rules: pairs.map(([, rule]) => rule ?? ""),
        reason: separator === -1 ? "" : rest.slice(separator + SEPARATOR.length),
      },
    ];
  });
}

/**
 * The rules a directive names, split at commas, before its reason.
 *
 * @param {string} list - The text between the directive and its ` -- ` separator.
 * @returns {string[]}
 */
function namedRules(list) {
  return list
    .split(",")
    .map((rule) => rule.trim())
    .filter((rule) => rule.length > 0);
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a reason after ` -- ` on every lint disable comment and every Effect directive that relaxes a rule, and optionally one rule per comment and only some directive kinds",
    },
    schema: [
      {
        type: "object",
        properties: {
          directives: { type: "array", items: { enum: [...DIRECTIVE_KINDS] }, uniqueItems: true },
          rules: { enum: ["any", "one"] },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missingReason:
        "Give this disable comment a reason: `{{directive}} <rule> -- <why the rule does not apply here>`, at least 8 non-space characters.",
      oneRule:
        "Name exactly one rule, not `*`, in this `{{directive}}` comment, so its reason covers exactly what it silences.",
      forbiddenDirective:
        "`{{directive}}` is not allowed here; use `{{allowed}}` on the line that needs it, naming one rule and a reason.",
    },
  },
  create(context) {
    const { directives, rules } = optionsOf(context);
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type === "Shebang") continue;
          const oxlint = oxlintDirective(comment.value);
          const found = [...(oxlint === undefined ? [] : [oxlint]), ...effectDirectives(comment.value)];
          for (const { directive, kind, spell, rules: named, reason } of found) {
            if (!directives.includes(kind)) {
              context.report({
                loc: comment.loc,
                messageId: "forbiddenDirective",
                data: {
                  directive,
                  allowed: [...new Set(directives.map((allowed) => spell(allowed)))].join("`, `"),
                },
              });
              continue;
            }
            if (rules === "one" && (named.length !== 1 || named[0] === "*")) {
              context.report({ loc: comment.loc, messageId: "oneRule", data: { directive } });
            }
            if (reason.replace(/[\s*]/gu, "").length < MINIMUM_REASON) {
              context.report({ loc: comment.loc, messageId: "missingReason", data: { directive } });
            }
          }
        }
      },
    };
  },
});
