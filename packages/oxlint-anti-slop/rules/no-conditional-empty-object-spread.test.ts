import { createRuleTester } from "../shared/rule-tester.ts";
import { noConditionalEmptyObjectSpreadRule } from "./no-conditional-empty-object-spread.ts";

const tester = createRuleTester("tsx");
const error = { messageId: "avoid" };

if (noConditionalEmptyObjectSpreadRule.meta?.fixable !== undefined) {
  throw new Error("The rule must not offer an unsafe semantics-changing fix.");
}

tester.run(
  "anti-slop/no-conditional-empty-object-spread",
  noConditionalEmptyObjectSpreadRule,
  {
    valid: [
      "const result = { value };",
      "const result = { ...values };",
      "const result = condition ? { value } : {};",
      {
        name: "JSX spread of props is not an empty-object omit",
        code: "const node = <svg {...props} />;",
      },
      {
        name: "JSX spread of null is not an empty-object omit",
        code: "const node = <div {...(inGroup ? { role: 'listitem' } : null)} />;",
      },
    ],
    invalid: [
      {
        code: "const result = { ...(value !== undefined ? { value } : {}) };",
        errors: [error],
      },
      {
        code: "const result = { ...(condition ? {} : { value }) };",
        errors: [error],
      },
      {
        name: "JSX spread of a conditional empty object",
        code: 'const node = <svg {...(label ? { role: "img", "aria-label": label } : {})} />;',
        errors: [error],
      },
    ],
  },
);
