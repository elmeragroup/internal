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
  ],
});
