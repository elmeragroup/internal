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
    {
      name: "exported alias",
      filename: component,
      code: `import { tv, type VariantProps } from "tailwind-variants";
const buttonVariants = tv({
  variants: { size: { sm: "text-sm" } },
  defaultVariants: { size: "sm" },
});
export type ButtonProps = VariantProps<typeof buttonVariants>;
`,
    },
    {
      name: "exported intersection",
      filename: component,
      code: `import { tv, type VariantProps } from "tailwind-variants";
const buttonVariants = tv({
  variants: { size: { sm: "text-sm" } },
  defaultVariants: { size: "sm" },
});
export type ButtonProps = React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>;
`,
    },
    {
      name: "exported interface extends helper",
      filename: component,
      code: `import { tv, type VariantProps } from "tailwind-variants";
const buttonVariants = tv({
  variants: { size: { sm: "text-sm" } },
  defaultVariants: { size: "sm" },
});
export interface ButtonProps extends VariantProps<typeof buttonVariants> {
  children?: string;
}
`,
    },
    {
      name: "interface extends local alias",
      filename: component,
      code: `import { tv, type VariantProps } from "tailwind-variants";
const buttonVariants = tv({
  variants: { size: { sm: "text-sm" } },
  defaultVariants: { size: "sm" },
});
type Base = VariantProps<typeof buttonVariants>;
export interface ButtonProps extends Base {}
`,
    },
    {
      name: "import type alias name",
      filename: component,
      code: `import { tv } from "tailwind-variants";
import type { VariantProps as VP } from "tailwind-variants";
const buttonVariants = tv({
  variants: { size: { sm: "text-sm" } },
  defaultVariants: { size: "sm" },
});
export type ButtonProps = VP<typeof buttonVariants>;
`,
    },
    {
      name: "parameter annotation through alias chain",
      filename: component,
      code: `import { tv, type VariantProps } from "tailwind-variants";
const buttonVariants = tv({
  variants: { size: { sm: "text-sm" } },
  defaultVariants: { size: "sm" },
});
type Base = VariantProps<typeof buttonVariants>;
type Props = Base & { children?: string };
export function Button(props: Props) {
  return null;
}
`,
    },
    {
      name: "memo callback parameter",
      filename: component,
      code: `import { tv, type VariantProps } from "tailwind-variants";
const buttonVariants = tv({
  variants: { size: { sm: "text-sm" } },
  defaultVariants: { size: "sm" },
});
type Props = VariantProps<typeof buttonVariants>;
export const Button = memo(function Inner(props: Props) {
  return null;
});
`,
    },
    {
      name: "export specifier list",
      filename: component,
      code: `import { tv, type VariantProps } from "tailwind-variants";
const buttonVariants = tv({
  variants: { size: { sm: "text-sm" } },
  defaultVariants: { size: "sm" },
});
type ButtonProps = VariantProps<typeof buttonVariants>;
export type { ButtonProps };
`,
    },
    {
      name: "two recipes both covered",
      filename: component,
      code: `import { tv, type VariantProps } from "tailwind-variants";
const buttonVariants = tv({
  variants: { size: { sm: "text-sm" } },
  defaultVariants: { size: "sm" },
});
const iconVariants = tv({
  variants: { size: { sm: "text-sm" } },
  defaultVariants: { size: "sm" },
});
export type ButtonProps = VariantProps<typeof buttonVariants> & VariantProps<typeof iconVariants>;
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
    {
      name: "comment only",
      filename: component,
      code: `import { tv } from "tailwind-variants";
const buttonVariants = tv({
  variants: { size: { sm: "text-sm" } },
  defaultVariants: { size: "sm" },
});
// props should use VariantProps<typeof buttonVariants>
`,
      errors: [{ messageId: "missingVariantProps" }],
    },
    {
      name: "unused import only",
      filename: component,
      code: `import { tv, type VariantProps } from "tailwind-variants";
const buttonVariants = tv({
  variants: { size: { sm: "text-sm" } },
  defaultVariants: { size: "sm" },
});
`,
      errors: [{ messageId: "missingVariantProps" }],
    },
    {
      name: "string literal only",
      filename: component,
      code: `import { tv } from "tailwind-variants";
const buttonVariants = tv({
  variants: { size: { sm: "text-sm" } },
  defaultVariants: { size: "sm" },
});
const label = "VariantProps";
`,
      errors: [{ messageId: "missingVariantProps" }],
    },
    {
      name: "different recipe",
      filename: component,
      code: `import { tv, type VariantProps } from "tailwind-variants";
const buttonVariants = tv({
  variants: { size: { sm: "text-sm" } },
  defaultVariants: { size: "sm" },
});
const iconVariants = tv({
  variants: { size: { sm: "text-sm" } },
  defaultVariants: { size: "sm" },
});
export type ButtonProps = VariantProps<typeof buttonVariants>;
`,
      errors: [{ messageId: "missingVariantProps" }],
    },
    {
      name: "unused local alias",
      filename: component,
      code: `import { tv, type VariantProps } from "tailwind-variants";
const buttonVariants = tv({
  variants: { size: { sm: "text-sm" } },
  defaultVariants: { size: "sm" },
});
type Base = VariantProps<typeof buttonVariants>;
export function Button(props: { size?: string }) {
  return null;
}
`,
      errors: [{ messageId: "missingVariantProps" }],
    },
    {
      name: "helper not from tailwind-variants",
      filename: component,
      code: `import { tv } from "tailwind-variants";
import type { VariantProps } from "./types";
const buttonVariants = tv({
  variants: { size: { sm: "text-sm" } },
  defaultVariants: { size: "sm" },
});
export type ButtonProps = VariantProps<typeof buttonVariants>;
`,
      errors: [{ messageId: "missingVariantProps" }],
    },
    {
      name: "locally declared VariantProps",
      filename: component,
      code: `import { tv } from "tailwind-variants";
const buttonVariants = tv({
  variants: { size: { sm: "text-sm" } },
  defaultVariants: { size: "sm" },
});
type VariantProps<T> = { size?: string };
export type ButtonProps = VariantProps<typeof buttonVariants>;
`,
      errors: [{ messageId: "missingVariantProps" }],
    },
    {
      name: "generic shadowing",
      filename: component,
      code: `import { tv, type VariantProps } from "tailwind-variants";
const buttonVariants = tv({
  variants: { size: { sm: "text-sm" } },
  defaultVariants: { size: "sm" },
});
type Base = VariantProps<typeof buttonVariants>;
export type ButtonProps<Base> = Base & { children?: string };
`,
      errors: [{ messageId: "missingVariantProps" }],
    },
    {
      name: "alias cycle",
      filename: component,
      code: `import { tv, type VariantProps } from "tailwind-variants";
const buttonVariants = tv({
  variants: { size: { sm: "text-sm" } },
  defaultVariants: { size: "sm" },
});
type A = B;
type B = A;
export type ButtonProps = A;
`,
      errors: [{ messageId: "missingVariantProps" }],
    },
  ],
});
