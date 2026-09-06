import { createRuleTester } from "../rule-tester.js";
import enforceVariantStandard from "./enforce-variant-standard.js";

const tester = createRuleTester("tsx");
const variants = "packages/ui/src/components/button/button-variants.ts";
const component = "packages/ui/src/components/button/button.tsx";

tester.run("elmera/enforce-variant-standard", enforceVariantStandard, {
  valid: [
    {
      name: "recipe with axes declares variants and defaultVariants",
      filename: variants,
      code: `import { tv } from "tailwind-variants";
export const buttonVariants = tv({
  variants: { size: { sm: "text-sm", md: "text-base" } },
  defaultVariants: { size: "sm" },
});
`,
    },
    {
      name: "axis-less slotted recipe omits variants and defaultVariants",
      filename: variants,
      code: `import { tv } from "tailwind-variants";
export const menuVariants = tv({
  slots: { item: "flex items-center", content: "p-1" },
});
`,
    },
    {
      name: "axis-less recipe in a component file does not need VariantProps",
      filename: component,
      code: `import { tv } from "tailwind-variants";
const chrome = tv({ slots: { root: "flex" } });
`,
    },
    {
      name: "recipe with axes and empty defaultVariants is accepted",
      filename: variants,
      code: `import { tv } from "tailwind-variants";
export const paginationVariants = tv({
  variants: { direction: { previous: { link: "pl-2.5" }, next: { link: "pr-2.5" } } },
  defaultVariants: {},
});
`,
    },
  ],
  invalid: [
    {
      name: "recipe with axes missing defaultVariants",
      filename: variants,
      code: `import { tv } from "tailwind-variants";
export const buttonVariants = tv({
  variants: { size: { sm: "text-sm" } },
});
`,
      errors: [{ messageId: "missingDefaultVariants" }],
    },
    {
      name: "component file with axes missing VariantProps",
      filename: component,
      code: `import { tv } from "tailwind-variants";
const buttonVariants = tv({
  variants: { size: { sm: "text-sm" } },
  defaultVariants: { size: "sm" },
});
`,
      errors: [{ messageId: "missingVariantProps" }],
    },
  ],
});
