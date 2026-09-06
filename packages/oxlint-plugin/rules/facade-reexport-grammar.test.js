import { createRuleTester } from "../rule-tester.js";
import facadeReexportGrammar from "./facade-reexport-grammar.js";

const tester = createRuleTester();
const error = { messageId: "grammar" };

tester.run("elmera/facade-reexport-grammar", facadeReexportGrammar, {
  valid: [
    {
      name: "explicit named re-exports",
      filename: "packages/ui/src/button.ts",
      code: `export { Button } from "./components/button/button";
export type { ButtonProps } from "./components/button/button";
export { buttonVariants } from "./components/button/button-variants";
`,
    },
    {
      name: "react-aria facade",
      filename: "packages/ui/src/react-aria/calendar.ts",
      code: `export { Calendar } from "./calendar/calendar";
`,
    },
    {
      name: "generated root barrel may use export *",
      filename: "packages/ui/src/index.ts",
      code: `export * from "./button";
export * from "./theme";
`,
    },
    {
      name: "implementation modules are not facades",
      filename: "packages/ui/src/components/button/button.tsx",
      code: `export function Button() {
  return null;
}
`,
    },
  ],
  invalid: [
    {
      name: "export * in a facade",
      filename: "packages/ui/src/button.ts",
      code: `export * from "./components/button/button";
`,
      errors: [error],
    },
    {
      name: "local declaration in a facade",
      filename: "packages/ui/src/button.ts",
      code: `export const Button = 1;
`,
      errors: [error],
    },
    {
      name: "directive in a facade",
      filename: "packages/ui/src/button.ts",
      code: `"use client";
export { Button } from "./components/button/button";
`,
      errors: [error],
    },
  ],
});
