import { createRuleTester } from "../rule-tester.js";
import noLocalFocusRing from "./no-local-focus-ring.js";

const tester = createRuleTester("tsx");
const error = { messageId: "localFocusRing" };
const adapter = "packages/ui/src/styles/utils.ts";
const component = "packages/ui/src/components/button/button.tsx";

tester.run("elmera/no-local-focus-ring", noLocalFocusRing, {
  valid: [
    {
      name: "adapter may define the self-focus ring",
      filename: adapter,
      code: `export const focusRing = "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";
`,
    },
    {
      name: "adapter may suppress outline on the state target",
      filename: adapter,
      code: `export const state = { root: "outline-none" };
`,
    },
    {
      name: "invalid-state rings are not matched",
      filename: component,
      code: `export const field = "aria-invalid:ring-3 aria-invalid:ring-error/20";
`,
    },
    {
      name: "static popup hairlines are not matched",
      filename: component,
      code: `export const popup = "ring-1 ring-foreground/10";
`,
    },
    {
      name: "focus-visible border is not a focus-within border",
      filename: component,
      code: `export const inline = "focus-visible:border-ring";
`,
    },
  ],
  invalid: [
    {
      name: "local focus-visible ring outside the adapter",
      filename: component,
      code: `export const local = "focus-visible:ring-2 focus-visible:ring-ring";
`,
      errors: [error],
    },
    {
      name: "outline-none outside the adapter",
      filename: component,
      code: `export const local = "relative flex outline-none";
`,
      errors: [error],
    },
    {
      name: "outline-hidden outside the adapter",
      filename: component,
      code: `export const popup = "w-72 outline-hidden";
`,
      errors: [error],
    },
    {
      name: "focus-within border colour outside the adapter",
      filename: component,
      code: `export const field = "focus-within:border-ring";
`,
      errors: [error],
    },
    {
      name: "named group-focus-within border colour outside the adapter",
      filename: component,
      code: `export const inline = "group-focus-within/inline-field:border-ring";
`,
      errors: [error],
    },
  ],
});
