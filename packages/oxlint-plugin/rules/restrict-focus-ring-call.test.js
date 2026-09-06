import { createRuleTester } from "../rule-tester.js";
import restrictFocusRingCall from "./restrict-focus-ring-call.js";

const tester = createRuleTester("tsx");
const error = { messageId: "restrictedCall" };
const utils = "packages/ui/src/styles/utils.ts";
const link = "packages/ui/src/react-aria/link/link.tsx";
const component = "packages/ui/src/components/button/button.tsx";

tester.run("elmera/restrict-focus-ring-call", restrictFocusRingCall, {
  valid: [
    {
      name: "utils may resolve the fixed rungs",
      filename: utils,
      code: `export const selfFocusRingClass = focusRing({ target: "self" }).root();
`,
    },
    {
      name: "react-aria/link may pass a live isFocusVisible",
      filename: link,
      code: `focusRing({ target: "state", isFocusVisible }).root();
`,
    },
    {
      name: "recipe-output tests may call the recipe",
      filename: "packages/ui/src/styles/utils.test.ts",
      code: `expect(selfFocusRingClass).toBe(focusRing({ target: "self" }).root());
`,
    },
    {
      name: "components may import the resolved constants",
      filename: component,
      code: `import { selfFocusRingClass } from "../../styles/utils";
`,
    },
  ],
  invalid: [
    {
      name: "component may not call focusRing with a fixed target",
      filename: component,
      code: `const local = focusRing({ target: "self" }).root();
`,
      errors: [error],
    },
    {
      name: "component may not call focusRing with a live isFocusVisible",
      filename: "packages/ui/src/react-aria/calendar/calendar.tsx",
      code: `focusRing({ target: "state", isFocusVisible }).root();
`,
      errors: [error],
    },
  ],
});
