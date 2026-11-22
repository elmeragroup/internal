import { createRuleTester } from "../rule-tester.js";
import requireDisableReason from "./require-disable-reason.js";

const tester = createRuleTester();
const missingReason = { messageId: "missingReason" };
const oneRule = { messageId: "oneRule" };
const forbiddenDirective = { messageId: "forbiddenDirective" };
const strict = [{ directives: ["disable-next-line"], rules: "one" }];
const ruleAfterReason = { messageId: "ruleAfterReason" };
const outsideComment = { messageId: "outsideComment" };
const noAllowedDirective = { messageId: "noAllowedDirective" };
/**
 * The Effect directive marker, spelled so no line of this file reads as a directive: \`@effect/tsgo\` applies one
 * found anywhere on a source line, strings included, and a literal one here would relax the Effect rules for this file.
 */
const EFFECT = "\x40effect-diagnostics";

tester.run("elmera/require-disable-reason", requireDisableReason, {
  valid: [
    {
      name: "next-line disable with a reason",
      code: "// oxlint-disable-next-line no-console -- the CLI's only output channel\nconsole.log(1);\n",
    },
    {
      name: "block comment with a reason",
      code: "/* oxlint-disable-next-line no-console -- the CLI's only output channel */\nconsole.log(1);\n",
    },
    {
      name: "eslint spelling with a reason",
      code: "// eslint-disable-next-line no-console -- the CLI's only output channel\nconsole.log(1);\n",
    },
    {
      name: "same-line disable with a reason",
      code: "console.log(1); // oxlint-disable-line no-console -- the CLI's only output channel\n",
    },
    {
      name: "file-wide disable with a reason by default",
      code: "/* oxlint-disable no-console -- this generated file prints its own report */\nconsole.log(1);\n",
    },
    {
      name: "several rules by default",
      code: "// oxlint-disable-next-line no-console, no-debugger -- a debugging fixture on purpose\nconsole.log(1);\n",
    },
    {
      name: "one rule and a next-line directive under the strict options",
      code: "// oxlint-disable-next-line no-console -- the CLI's only output channel\nconsole.log(1);\n",
      options: strict,
    },
    {
      name: "a comment that only mentions a directive",
      code: "// Use oxlint-disable-next-line sparingly.\nconst value = 1;\n",
    },
    {
      name: "an enable directive needs no reason",
      code: "/* oxlint-enable no-console */\nconst value = 1;\n",
    },
    {
      name: "Effect next-line directive with a reason",
      code: `// ${EFFECT}-next-line floatingEffect:off -- the fiber is forked on purpose\nconst value = 1;\n`,
    },
    {
      name: "Effect section directive with a reason by default",
      code: `// ${EFFECT} globalDate:off -- this script stamps wall-clock time\nconst value = 1;\n`,
    },
    {
      name: "Effect directive that only raises a rule needs no reason",
      code: `// ${EFFECT} floatingEffect:error\nconst value = 1;\n`,
    },
    {
      name: "Effect next-line directive naming one rule under the strict options",
      code: `// ${EFFECT}-next-line floatingEffect:off -- the fiber is forked on purpose\nconst value = 1;\n`,
      options: strict,
    },
    {
      name: "a comment that only describes the Effect directive form",
      code: `// Suppress with \`${EFFECT}-next-line <rule>:off\` and a reason.\nconst value = 1;\n`,
    },
    {
      name: "an escaped marker in a string reads as no directive",
      code: 'const snippet = "\\x40effect-diagnostics-next-line floatingEffect:off";\n',
    },
    {
      name: "a string that only raises an Effect rule relaxes nothing",
      code: `const snippet = "${EFFECT}-next-line floatingEffect:error";\n`,
    },
    {
      name: "only a line's leftmost Effect directive applies",
      code: `const snippet = "${EFFECT} floatingEffect:error"; // ${EFFECT}-next-line globalDate:off\nconst value = 1;\n`,
    },
    {
      name: "an Effect directive on a later line of a block comment, with a reason",
      code: `/*\n * ${EFFECT}-next-line floatingEffect:off -- the fiber is forked on purpose\n */\nconst value = 1;\n`,
      options: strict,
    },
    {
      name: "a next-line Effect directive whose pairs all come before its reason",
      code: `// ${EFFECT}-next-line floatingEffect:off -- the fiber is forked on purpose\nconst value = 1;\n`,
      options: [{ directives: ["disable", "disable-next-line"], rules: "one" }],
    },
    {
      name: "a rule the reason raises to an error relaxes nothing",
      code: `// ${EFFECT}-next-line floatingEffect:off -- the fiber is forked; globalDate:error stays on\nconst value = 1;\n`,
    },
    {
      name: "a file-wide skip where file-wide directives are allowed",
      code: `// ${EFFECT}-next-line preferNamespaceImport:skip-file -- this example is generated\nconst value = 1;\n`,
    },
  ],
  invalid: [
    {
      name: "next-line disable without a reason",
      code: "// oxlint-disable-next-line no-console\nconsole.log(1);\n",
      errors: [missingReason],
    },
    {
      name: "a reason too short to say anything",
      code: "// oxlint-disable-next-line no-console -- needed\nconsole.log(1);\n",
      errors: [missingReason],
    },
    {
      name: "a separator without spaces is no reason",
      code: "// oxlint-disable-next-line no-console --the CLI's only output channel\nconsole.log(1);\n",
      errors: [missingReason],
    },
    {
      name: "eslint spelling without a reason",
      code: "// eslint-disable-next-line no-console\nconsole.log(1);\n",
      errors: [missingReason],
    },
    {
      name: "file-wide disable without a reason",
      code: "/* oxlint-disable */\nconsole.log(1);\n",
      errors: [missingReason],
    },
    {
      name: "same-line disable without a reason",
      code: "console.log(1); // oxlint-disable-line no-console\n",
      errors: [missingReason],
    },
    {
      name: "a block comment's stars are no reason",
      code: "/* oxlint-disable-next-line no-console -- ** */\nconsole.log(1);\n",
      errors: [missingReason],
    },
    {
      name: "two rules under the one-rule option",
      code: "// oxlint-disable-next-line no-console, no-debugger -- a debugging fixture on purpose\nconsole.log(1);\n",
      options: strict,
      errors: [oneRule],
    },
    {
      name: "no rule under the one-rule option silences every rule",
      code: "// oxlint-disable-next-line -- a debugging fixture on purpose\nconsole.log(1);\n",
      options: strict,
      errors: [oneRule],
    },
    {
      name: "a file-wide disable where only next-line directives are allowed",
      code: "/* oxlint-disable no-console -- this generated file prints its own report */\nconsole.log(1);\n",
      options: strict,
      errors: [forbiddenDirective],
    },
    {
      name: "a same-line disable where only next-line directives are allowed",
      code: "console.log(1); // oxlint-disable-line no-console -- the CLI's only output channel\n",
      options: strict,
      errors: [forbiddenDirective],
    },
    {
      name: "one rule and a reason are both reported when both are missing",
      code: "// oxlint-disable-next-line no-console, no-debugger\nconsole.log(1);\n",
      options: strict,
      errors: [oneRule, missingReason],
    },
    {
      name: "Effect next-line directive without a reason",
      code: `// ${EFFECT}-next-line floatingEffect:off\nconst value = 1;\n`,
      errors: [missingReason],
    },
    {
      name: "Effect file-wide wildcard without a reason",
      code: `// ${EFFECT} *:off\nconst value = 1;\n`,
      errors: [missingReason],
    },
    {
      name: "Effect skip-file without a reason",
      code: `/* ${EFFECT} *:skip-file */\nconst value = 1;\n`,
      errors: [missingReason],
    },
    {
      name: "Effect downgrade to a warning without a reason",
      code: `// ${EFFECT}-next-line floatingEffect:warning\nconst value = 1;\n`,
      errors: [missingReason],
    },
    {
      name: "Effect directive mid-comment without a reason",
      code: `// see below ${EFFECT}-next-line floatingEffect:off\nconst value = 1;\n`,
      errors: [missingReason],
    },
    {
      name: "Effect section directive where only next-line directives are allowed",
      code: `// ${EFFECT} preferNamespaceImport:off -- this module keeps named imports\nconst value = 1;\n`,
      options: strict,
      errors: [forbiddenDirective],
    },
    {
      name: "Effect wildcard under the one-rule option silences every rule",
      code: `// ${EFFECT}-next-line *:off -- the fiber is forked on purpose\nconst value = 1;\n`,
      options: strict,
      errors: [oneRule],
    },
    {
      name: "two Effect rules under the one-rule option",
      code: `// ${EFFECT}-next-line floatingEffect:off globalDate:off -- a deliberate fixture\nconst value = 1;\n`,
      options: strict,
      errors: [oneRule],
    },
    {
      name: "an Effect pair hidden in the reason counts as a rule it names",
      code: `// ${EFFECT}-next-line floatingEffect:off -- see globalDate:off too\nconst value = 1;\n`,
      options: strict,
      errors: [ruleAfterReason, oneRule, missingReason],
    },
    {
      name: "an Effect directive in a string literal still applies, outside any comment",
      code: `export const snippet = "${EFFECT}-next-line preferNamespaceImport:off";\nconst value = 1;\n`,
      errors: [outsideComment],
    },
    {
      name: "an Effect directive on a later line of a template literal still applies",
      code: `export const snippet = \`\n${EFFECT} *:skip-file -- not a comment\n\`;\n`,
      errors: [outsideComment],
    },
    {
      name: "skip-file behind the next-line prefix is file-wide where only next-line directives are allowed",
      code: `// ${EFFECT}-next-line preferNamespaceImport:skip-file -- this example is generated\nconst value = 1;\n`,
      options: strict,
      errors: [{ messageId: "skipFile", data: { directive: "\x40effect-diagnostics-next-line" } }],
    },
    {
      name: "a rule written only after the separator is no reason",
      code: `// ${EFFECT}-next-line -- preferNamespaceImport:off\nconst value = 1;\n`,
      errors: [ruleAfterReason, missingReason],
    },
    {
      name: "a rule after the separator does not count toward the reason's length",
      code: `// ${EFFECT}-next-line floatingEffect:off -- globalDate:off\nconst value = 1;\n`,
      errors: [ruleAfterReason, missingReason],
    },
    {
      name: "the suggestion names only the Effect forms the configuration allows",
      code: `// ${EFFECT}-next-line floatingEffect:off -- the fiber is forked on purpose\nconst value = 1;\n`,
      options: [{ directives: ["disable", "disable-line"] }],
      errors: [
        {
          messageId: "forbiddenDirective",
          data: { directive: "\x40effect-diagnostics-next-line", allowed: "\x40effect-diagnostics" },
        },
      ],
    },
    {
      name: "a second relaxing rule in a next-line directive's reason",
      code: `// ${EFFECT}-next-line floatingEffect:off -- unlike preferNamespaceImport:off this is deliberate\nconst value = 1;\n`,
      errors: [ruleAfterReason],
    },
    {
      name: "a second relaxing rule in a section directive's reason",
      code: `// ${EFFECT} floatingEffect:off -- generated fixture also documents preferNamespaceImport:off\nconst value = 1;\n`,
      errors: [ruleAfterReason],
    },
    {
      name: "a block comment's closing delimiter is no part of a seven-character reason",
      code: `/* ${EFFECT}-next-line floatingEffect:off -- abcdefg */\nconst value = 1;\n`,
      errors: [missingReason],
    },
    {
      name: "a configuration that allows no Effect form says so",
      code: `// ${EFFECT}-next-line floatingEffect:off -- the fiber is forked on purpose\nconst value = 1;\n`,
      options: [{ directives: ["disable-line"] }],
      errors: [noAllowedDirective],
    },
  ],
});
