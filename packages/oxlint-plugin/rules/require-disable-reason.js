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
        "Require a reason after ` -- ` on every lint disable comment, and optionally one rule per comment and only some directive kinds",
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
        "Name exactly one rule in this `{{directive}}` comment, so its reason covers exactly what it silences.",
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
          const match = DIRECTIVE.exec(comment.value);
          const kind = match?.[1];
          if (match === null || kind === undefined || !isDirectiveKind(kind)) continue;
          const directive = match[0].trim();
          if (!directives.includes(kind)) {
            context.report({
              loc: comment.loc,
              messageId: "forbiddenDirective",
              data: { directive, allowed: directives.map((allowed) => `oxlint-${allowed}`).join("`, `") },
            });
            continue;
          }
          const rest = comment.value.slice(match[0].length);
          const separator = rest.indexOf(SEPARATOR);
          const list = separator === -1 ? rest : rest.slice(0, separator);
          const reason = separator === -1 ? "" : rest.slice(separator + SEPARATOR.length);
          if (rules === "one" && namedRules(list).length !== 1) {
            context.report({ loc: comment.loc, messageId: "oneRule", data: { directive } });
          }
          if (reason.replace(/[\s*]/gu, "").length < MINIMUM_REASON) {
            context.report({ loc: comment.loc, messageId: "missingReason", data: { directive } });
          }
        }
      },
    };
  },
});
