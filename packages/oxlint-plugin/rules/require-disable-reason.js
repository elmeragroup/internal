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

/*
 * Effect directives, as the pinned `@effect/tsgo` 0.70.0 reads them (`crates/ets_directives/src/parser.rs`,
 * `collect_effect_directives` and `build_directive_set`; Go twin `internal/directives/parser.go`):
 *
 * - It scans every physical line of the source (the text split at `\n`), blind to comments, strings and templates, so
 *   a directive spelled in a string literal applies as surely as one in a comment.
 * - It takes the leftmost match of the directive pattern on each line and ignores the rest of the line.
 * - The match's token run (whitespace-separated runs of `[0-9A-Za-z_:\-*]`) yields every `rule:severity` pair found
 *   anywhere in it, inside a longer token too. A line whose run holds no pair is no directive.
 * - The severity is read case-blind: `off`, `skip-file`, `warning`/`warn`, `suggestion`, `message`, `error`; any
 *   other word reads as `error`. A rule name matches case-blind, and `*` matches every rule.
 * - A `skip-file` pair holds for the whole file wherever it is written, behind the next-line prefix too. Otherwise the
 *   next-line form holds for the following line, and the bare form for its own line and every later one, until a later
 *   bare directive names the rule again.
 * - ` -- ` means nothing to it: `--` is one more token, and a pair written after it, in the reason, still applies.
 *
 * This rule reads the same lines the same way. A relaxing directive outside a comment is reported, since no comment
 * can carry its reason; one inside a comment writes every pair it relaxes before ` -- ` (one in the reason still
 * applies) and a reason after it, ending where a block comment closes, and takes the allowed-kinds and one-rule options,
 * a `skip-file` pair counting as the file-wide `disable` kind.
 */

/** The upstream directive pattern, with RE2's ASCII classes. */
const EFFECT_DIRECTIVE =
  /@effect-diagnostics(-next-line)?[\t\n\f\r ]+([0-9A-Za-z_:\-*]+(?:[\t\n\f\r ]+[0-9A-Za-z_:\-*]+)*)/u;

/** The upstream `rule:severity` pattern, applied across a directive's whole token run. */
const EFFECT_RULE_SEVERITY = /([0-9A-Za-z_]+|\*):([0-9A-Za-z_]+(?:-[0-9A-Za-z_]+)?)/gu;

/**
 * The severities below `error` (`etscore/severity.go`). Each relaxes a rule below the error a gate configures;
 * `skip-file` also makes a directive file-wide.
 */
const EFFECT_RELAXING = new Set(["off", "skip-file", "warning", "warn", "suggestion", "message"]);

/** The severity that holds for the whole file wherever it is written. */
const EFFECT_SKIP_FILE = "skip-file";

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
 * @typedef {object} Location
 * @property {{ line: number, column: number }} start
 * @property {{ line: number, column: number }} end
 */

/**
 * One directive, in either family, as the policy checks it.
 *
 * @typedef {object} Directive
 * @property {string} directive - The directive as written, for messages.
 * @property {DirectiveKind} kind - Its scope: `disable-next-line` for a next-line directive, `disable`
 *   for one that holds to the end of the file or of its section.
 * @property {(kind: DirectiveKind) => string | undefined} spell - How its family writes a directive of a
 *   kind, or `undefined` for a kind the family has no form for.
 * @property {ReadonlyArray<string>} rules - The rules it names; `*` names every rule.
 * @property {string} reason - The text after its ` -- ` separator, less any rule the backend still reads there.
 * @property {boolean} inComment - Whether it is written in a comment, where a reason can follow it.
 * @property {boolean} relaxesInReason - Whether it relaxes a rule written after ` -- `, which `@effect/tsgo` applies.
 * @property {boolean} skipsFile - Whether a `skip-file` pair, rather than its form, makes it file-wide.
 * @property {Location} loc - Where to report it.
 */

/**
 * The oxlint or eslint disable directive at the start of a comment.
 *
 * @param {string} text - The comment's text.
 * @param {Location} loc - The comment's location.
 * @returns {Directive | undefined}
 */
function oxlintDirective(text, loc) {
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
    inComment: true,
    relaxesInReason: false,
    skipsFile: false,
    loc,
  };
}

/**
 * How `@effect/tsgo` writes a directive of a kind; it has no same-line form.
 *
 * @param {DirectiveKind} kind
 * @returns {string | undefined}
 */
function spellEffect(kind) {
  if (kind === "disable") return "@effect-diagnostics";
  if (kind === "disable-next-line") return "@effect-diagnostics-next-line";
  return undefined;
}

/**
 * The Effect directives in a source that relax a rule, read as `@effect/tsgo` reads them (see above). A directive
 * that only raises rules to errors needs no reason.
 *
 * @param {string} text - The whole source text.
 * @param {ReadonlyArray<{ type: string, start: number, end: number }>} comments - Its comments, as offsets into `text`.
 * @param {(offset: number) => { line: number, column: number }} locate - Maps an offset to a location.
 * @returns {Directive[]}
 */
function effectDirectives(text, comments, locate) {
  /** @type {Directive[]} */
  const found = [];
  let lineStart = 0;
  for (const line of text.split("\n")) {
    const match = EFFECT_DIRECTIVE.exec(line);
    const tokens = match?.[2];
    if (match !== null && tokens !== undefined) {
      const tokensStart = match.index + match[0].length - tokens.length;
      const pairs = [...tokens.matchAll(EFFECT_RULE_SEVERITY)].map((pair) => ({
        rule: pair[1] ?? "",
        severity: (pair[2] ?? "").toLowerCase(),
        start: tokensStart + pair.index,
        end: tokensStart + pair.index + pair[0].length,
      }));
      const relaxing = pairs.filter(({ severity }) => EFFECT_RELAXING.has(severity));
      if (relaxing.length > 0) {
        const start = lineStart + match.index;
        const comment = comments.find((candidate) => candidate.start <= start && start < candidate.end);
        // A block comment's closing `*/` ends the reason, so it never counts toward the reason's length.
        const commentEnd =
          comment === undefined ? line.length : comment.end - lineStart - (comment.type === "Block" ? 2 : 0);
        const lineEnd = Math.min(line.length, commentEnd);
        const separatorAt = line.indexOf(SEPARATOR, match.index);
        const separator = separatorAt === -1 || separatorAt >= lineEnd ? lineEnd : separatorAt;
        const afterSeparator = pairs.filter((pair) => pair.start >= separator);
        let reason = separator === lineEnd ? "" : line.slice(separator + SEPARATOR.length, lineEnd);
        for (const pair of [...afterSeparator].reverse()) {
          const at = pair.start - separator - SEPARATOR.length;
          reason = reason.slice(0, at) + reason.slice(at + pair.end - pair.start);
        }
        const next = match[1] ?? "";
        const skipsFile = pairs.some(({ severity }) => severity === EFFECT_SKIP_FILE);
        found.push({
          directive: `@effect-diagnostics${next}`,
          kind: next === "" || skipsFile ? "disable" : "disable-next-line",
          skipsFile,
          spell: spellEffect,
          rules: pairs.map(({ rule }) => rule),
          reason,
          inComment: comment !== undefined,
          relaxesInReason: relaxing.some((pair) => pair.start >= separator),
          loc: { start: locate(start), end: locate(lineStart + match.index + match[0].length) },
        });
      }
    }
    lineStart += line.length + 1;
  }
  return found;
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
      noAllowedDirective:
        "`{{directive}}` is not allowed here, and this configuration allows no directive of its kind; fix what it would silence.",
      outsideComment:
        "`{{directive}}` is outside a comment, yet `@effect/tsgo` reads every source line and applies it here; write it in a comment with a reason, or spell the text so it no longer reads as a directive (for example `\\x40effect-diagnostics`).",
      skipFile:
        "`{{directive}}` with a `skip-file` severity silences the rule for the whole file, which is not allowed here; use `@effect-diagnostics-next-line <rule>:off` on the line that needs it, with a reason.",
      ruleAfterReason:
        "Write every rule this `{{directive}}` relaxes before ` -- `; `@effect/tsgo` applies a relaxing `rule:severity` after the separator too, so it is no reason.",
    },
  },
  create(context) {
    const { directives, rules } = optionsOf(context);
    return {
      Program() {
        const { sourceCode } = context;
        const comments = sourceCode.getAllComments().filter((comment) => comment.type !== "Shebang");
        const found = [
          ...comments.flatMap((comment) => oxlintDirective(comment.value, comment.loc) ?? []),
          ...effectDirectives(sourceCode.text, comments, (offset) => sourceCode.getLocFromIndex(offset)),
        ];
        for (const {
          directive,
          kind,
          spell,
          rules: named,
          reason,
          inComment,
          relaxesInReason,
          skipsFile,
          loc,
        } of found) {
          if (!inComment) {
            context.report({ loc, messageId: "outsideComment", data: { directive } });
            continue;
          }
          if (!directives.includes(kind) && skipsFile && directives.includes("disable-next-line")) {
            context.report({ loc, messageId: "skipFile", data: { directive } });
            continue;
          }
          if (!directives.includes(kind)) {
            const allowed = [...new Set(directives.flatMap((candidate) => spell(candidate) ?? []))];
            context.report(
              allowed.length === 0
                ? { loc, messageId: "noAllowedDirective", data: { directive } }
                : { loc, messageId: "forbiddenDirective", data: { directive, allowed: allowed.join("`, `") } }
            );
            continue;
          }
          if (relaxesInReason) {
            context.report({ loc, messageId: "ruleAfterReason", data: { directive } });
          }
          if (rules === "one" && (named.length !== 1 || named[0] === "*")) {
            context.report({ loc, messageId: "oneRule", data: { directive } });
          }
          if (reason.replace(/[\s*]/gu, "").length < MINIMUM_REASON) {
            context.report({ loc, messageId: "missingReason", data: { directive } });
          }
        }
      },
    };
  },
});
