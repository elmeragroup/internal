import { createRuleTester } from "../rule-tester.js";
import requireDisableReason from "./require-disable-reason.js";

const tester = createRuleTester();
const missingReason = { messageId: "missingReason" };
const oneRule = { messageId: "oneRule" };
const forbiddenDirective = { messageId: "forbiddenDirective" };
const strict = [{ directives: ["disable-next-line"], rules: "one" }];

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
      code: "// @effect-diagnostics-next-line floatingEffect:off -- the fiber is forked on purpose\nconst value = 1;\n",
    },
    {
      name: "Effect section directive with a reason by default",
      code: "// @effect-diagnostics globalDate:off -- this script stamps wall-clock time\nconst value = 1;\n",
    },
    {
      name: "Effect directive that only raises a rule needs no reason",
      code: "// @effect-diagnostics floatingEffect:error\nconst value = 1;\n",
    },
    {
      name: "Effect next-line directive naming one rule under the strict options",
      code: "// @effect-diagnostics-next-line floatingEffect:off -- the fiber is forked on purpose\nconst value = 1;\n",
      options: strict,
    },
    {
      name: "a comment that only describes the Effect directive form",
      code: "// Suppress with `@effect-diagnostics-next-line <rule>:off` and a reason.\nconst value = 1;\n",
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
      code: "// @effect-diagnostics-next-line floatingEffect:off\nconst value = 1;\n",
      errors: [missingReason],
    },
    {
      name: "Effect file-wide wildcard without a reason",
      code: "// @effect-diagnostics *:off\nconst value = 1;\n",
      errors: [missingReason],
    },
    {
      name: "Effect skip-file without a reason",
      code: "/* @effect-diagnostics *:skip-file */\nconst value = 1;\n",
      errors: [missingReason],
    },
    {
      name: "Effect downgrade to a warning without a reason",
      code: "// @effect-diagnostics-next-line floatingEffect:warning\nconst value = 1;\n",
      errors: [missingReason],
    },
    {
      name: "Effect directive mid-comment without a reason",
      code: "// see below @effect-diagnostics-next-line floatingEffect:off\nconst value = 1;\n",
      errors: [missingReason],
    },
    {
      name: "Effect section directive where only next-line directives are allowed",
      code: "// @effect-diagnostics preferNamespaceImport:off -- this module keeps named imports\nconst value = 1;\n",
      options: strict,
      errors: [forbiddenDirective],
    },
    {
      name: "Effect wildcard under the one-rule option silences every rule",
      code: "// @effect-diagnostics-next-line *:off -- the fiber is forked on purpose\nconst value = 1;\n",
      options: strict,
      errors: [oneRule],
    },
    {
      name: "two Effect rules under the one-rule option",
      code: "// @effect-diagnostics-next-line floatingEffect:off globalDate:off -- a deliberate fixture\nconst value = 1;\n",
      options: strict,
      errors: [oneRule],
    },
    {
      name: "an Effect pair hidden in the reason counts as a rule it names",
      code: "// @effect-diagnostics-next-line floatingEffect:off -- see globalDate:off too\nconst value = 1;\n",
      options: strict,
      errors: [oneRule],
    },
  ],
});
