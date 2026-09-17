import { createRuleTester } from "../rule-tester.js";
import restrictProcessEnv from "./restrict-process-env.js";

const tester = createRuleTester();
const error = { messageId: "restrictedAccess" };
const validator = "packages/ui/src/theme/validate-theme.ts";
const component = "packages/ui/src/components/button/button.tsx";

tester.run("elmera/restrict-process-env", restrictProcessEnv, {
  valid: [
    {
      name: "strict equality NODE_ENV comparison in the validator",
      filename: validator,
      code: `if (process.env.NODE_ENV === "production") {}
`,
    },
    {
      name: "strict inequality NODE_ENV comparison in the validator",
      filename: validator,
      code: `if (process.env.NODE_ENV !== "production") {}
`,
    },
    {
      name: "loose equality NODE_ENV comparison in the validator",
      filename: validator,
      code: `if (process.env.NODE_ENV == "production") {}
`,
    },
    {
      name: "loose inequality NODE_ENV comparison in the validator",
      filename: validator,
      code: `if (process.env.NODE_ENV != "production") {}
`,
    },
    {
      name: "computed NODE_ENV comparison in the validator",
      filename: validator,
      code: `if (process.env["NODE_ENV"] === "production") {}
`,
    },
  ],
  invalid: [
    {
      name: "NODE_ENV comparison outside the validator",
      filename: component,
      code: `if (process.env.NODE_ENV === "production") {}
`,
      errors: [error],
    },
    {
      name: "another env variable in the validator",
      filename: validator,
      code: `const api = process.env.API_URL;
`,
      errors: [error],
    },
    {
      name: "NODE_ENV read without a comparison in the validator",
      filename: validator,
      code: `const mode = process.env.NODE_ENV;
`,
      errors: [error],
    },
    {
      name: "a filename merely ending with the validator suffix is not the validator",
      filename: "packages/ui/src/theme/validate-theme.test.ts",
      code: `if (process.env.NODE_ENV === "production") {}
`,
      errors: [error],
    },
    {
      name: "env access outside the validator",
      filename: component,
      code: `const flag = process.env.FEATURE_FLAG;
`,
      errors: [error],
    },
    {
      name: "computed env access outside the validator",
      filename: component,
      code: `const flag = process.env["FEATURE_FLAG"];
`,
      errors: [error],
    },
  ],
});
