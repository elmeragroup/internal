import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRuleTester } from "../rule-tester.js";
import noHardcodedDensityMetrics from "./no-hardcoded-density-metrics.js";

const tester = createRuleTester();
const error = { messageId: "hardcodedMetric" };

const buttonVariantsSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../fixtures/button-variants.txt"),
  "utf8"
);

/**
 * @param {string} sizeObject
 */
function recipe(sizeObject) {
  return `import { tv } from "tailwind-variants";
export const recipe = tv({
  base: "inline-flex rounded-md border border-transparent active:translate-y-px",
  variants: {
    variant: { default: "bg-primary" },
    size: ${sizeObject},
  },
  defaultVariants: { variant: "default", size: "default" },
});
`;
}

tester.run("elmera/no-hardcoded-density-metrics", noHardcodedDensityMetrics, {
  valid: [
    {
      name: "size axis reads control height variable",
      code: recipe('{ default: "h-(--control-h-md)" }'),
    },
    {
      name: "icon-inline hit-area and line-height sizing stay legal",
      code: recipe('{ "icon-inline": "hit-area-1 aspect-square h-lh w-auto" }'),
    },
    {
      name: "radius clamps stay legal",
      code: recipe('{ xs: "h-(--control-h-xs) rounded-[min(var(--radius-md),8px)]" }'),
    },
    {
      name: "icon glyph size on svg children stays legal",
      code: recipe("{ xs: \"h-(--control-h-xs) [&_svg:not([class*='size-'])]:size-3\" }"),
    },
    {
      name: "size-owned sm type stays legal",
      code: recipe('{ sm: "text-sm h-(--control-h-sm) px-(--control-px-sm)" }'),
    },
    {
      name: "size-owned xs type stays legal",
      code: recipe('{ xs: "text-xs h-(--control-h-xs)" }'),
    },
    {
      name: "token-read md/lg type stays legal",
      code: recipe(
        '{ default: "h-(--control-h-md) [font-size:var(--control-text)] [line-height:var(--control-leading)]" }'
      ),
    },
    {
      name: "numeric spacing on the color variant axis is not a size-axis metric",
      code: `import { tv } from "tailwind-variants";
export const recipe = tv({
  base: "h-9 px-2.5 gap-1.5 text-sm",
  variants: {
    variant: { default: "h-9 px-2.5" },
    size: { default: "h-(--control-h-md)" },
  },
  defaultVariants: { variant: "default", size: "default" },
});
`,
    },
    {
      name: "layout gap and translation outside tv are not matched",
      code: `const layout = "gap-4 p-6 translate-y-px";
`,
    },
    {
      name: "vertical padding in the size axis is not density-owned",
      code: recipe('{ default: "h-(--control-h-md) py-2" }'),
    },
    {
      name: "square icon rung reads control height via size-*",
      code: recipe('{ icon: "size-(--control-h-md)" }'),
    },
    {
      name: "type-scale size axis is not a density rung",
      code: recipe(
        '{ xs: "text-xs *:text-xs", sm: "text-sm", default: "text-base *:text-base **:text-base", lg: "text-lg leading-snug" }'
      ),
    },
    {
      name: "overlay max-width size axis with layout padding is not a density rung",
      code: recipe('{ sm: "max-w-sm p-6", md: "max-w-[min(var(--container-md),90%)]" }'),
    },
    {
      name: "layout item size axis without a control height is not a density rung",
      code: recipe('{ default: "gap-3.5 px-4 py-3.5", sm: "gap-2.5 px-3 py-2.5", xs: "gap-2 px-2.5 py-2" }'),
    },
    {
      name: "Button recipe after density retokenization has no false positives",
      filename: "packages/ui/src/components/button/button-variants.ts",
      code: buttonVariantsSource,
    },
    {
      name: "data-size reads control height variables",
      code: `export const trigger = "flex data-[size=default]:h-(--control-h-md) data-[size=sm]:h-(--control-h-sm)";
`,
    },
    {
      name: "field-box tv without a size axis may read control variables",
      code: `import { tv } from "tailwind-variants";
export const recipe = tv({
  base: "h-(--control-h-md) w-full px-(--control-px-md) [font-size:var(--control-text)]",
});
`,
    },
    {
      name: "decorative variant axis with fixed media sizes is not a density rung",
      code: `import { tv } from "tailwind-variants";
export const recipe = tv({
  base: "flex shrink-0 items-center gap-2",
  variants: { variant: { default: "bg-transparent", image: "size-10 rounded-sm" } },
  defaultVariants: { variant: "default" },
});
`,
    },
    {
      name: "field-box box axis may pin the control rung on one arm",
      code: `import { tv } from "tailwind-variants";
export const recipe = tv({
  base: "w-full px-(--control-px-md) [font-size:var(--control-text)]",
  variants: { box: { control: "h-(--control-h-md)", content: "min-h-16 py-2" } },
  defaultVariants: { box: "control" },
});
`,
    },
    {
      name: "optical arbitrary pixel track sizes on data-size stay legal",
      code: `export const track = "data-[size=default]:h-[18.4px] data-[size=sm]:h-[14px]";
`,
    },
    {
      name: "descendant has-data-size gap on a layout group is not a density rung",
      code: `export const group = "flex flex-col gap-4 has-data-[size=sm]:gap-2.5 has-data-[size=xs]:gap-2";
`,
    },
    {
      name: "orientation recipe without a control height is not a field box",
      code: `import { tv } from "tailwind-variants";
export const recipe = tv({
  base: "group/field flex w-full gap-3",
  variants: { orientation: { vertical: "flex-col", horizontal: "flex-row" } },
});
`,
    },
    {
      name: "cn height literal is quiet when the file does not pin --control-h-",
      code: `export const chrome = cn("flex h-8 w-full px-2");
`,
    },
    {
      name: "tv slot layout gap is quiet when the file does not pin --control-h-",
      code: `import { tv } from "tailwind-variants";
export const recipe = tv({
  slots: { base: "flex flex-col gap-1", card: "p-4" },
});
`,
    },
    {
      name: "tv slot beside a pin may read control variables",
      code: `import { tv } from "tailwind-variants";
/** field box pins h-(--control-h-md) */
export const recipe = tv({
  slots: {
    input: "px-(--control-px-md) [font-size:var(--control-text)] [line-height:var(--control-leading)]",
  },
});
`,
    },
    {
      name: "Button-size-keyed record may read control height variables",
      code: `const iconButtonSizes = {
  "icon-xs": "size-(--control-h-xs)",
  "icon-sm": "size-(--control-h-sm)",
  icon: "size-(--control-h-md)",
  "icon-lg": "size-(--control-h-lg)",
};
`,
    },
    {
      name: "non-size-keyed record with literal height is not a density ladder",
      code: `const media = { image: "size-10 rounded-sm", video: "size-16" };
`,
    },
  ],
  invalid: [
    {
      name: "warns on hardcoded control height in the size axis",
      code: recipe('{ default: "h-9" }'),
      errors: [error],
    },
    {
      name: "warns on hardcoded inline padding",
      code: recipe('{ default: "h-9 px-2.5" }'),
      errors: [error, error],
    },
    {
      name: "warns on hardcoded icon-edge padding",
      code: recipe('{ default: "h-9 has-data-[icon=inline-start]:pl-2" }'),
      errors: [error, error],
    },
    {
      name: "warns on hardcoded control gap",
      code: recipe('{ default: "h-9 gap-1.5" }'),
      errors: [error, error],
    },
    {
      name: "warns on hardcoded md control type",
      code: recipe('{ default: "h-(--control-h-md) text-sm" }'),
      errors: [error],
    },
    {
      name: "warns on hardcoded lg control type",
      code: recipe('{ lg: "h-(--control-h-lg) text-base leading-6" }'),
      errors: [error, error],
    },
    {
      name: "warns on hardcoded square control size",
      code: recipe('{ icon: "size-9" }'),
      errors: [error],
    },
    {
      name: "warns on hardcoded height on icon-inline",
      code: recipe('{ "icon-inline": "h-9 hit-area-1" }'),
      errors: [error],
    },
    {
      name: "Select-style data-[size=default]:h-9 literal fails",
      code: `export const trigger = "flex w-fit items-center data-[size=default]:h-9 data-[size=sm]:h-8";
`,
      errors: [error, error],
    },
    {
      name: "data-[size] token inside a tv size axis reports once, not twice",
      code: recipe('{ default: "h-9 data-[size=default]:h-8" }'),
      errors: [error, error],
    },
    {
      name: "field-box tv without a size axis still flags hardcoded height",
      code: `import { tv } from "tailwind-variants";
export const recipe = tv({
  base: "h-9 w-full px-2.5",
});
`,
      errors: [error, error],
    },
    {
      name: "field-box box axis still flags a hardcoded control height",
      code: `import { tv } from "tailwind-variants";
export const recipe = tv({
  base: "w-full px-(--control-px-md)",
  variants: { box: { control: "h-9", content: "min-h-16 py-2" } },
  defaultVariants: { box: "control" },
});
`,
      errors: [error],
    },
    {
      name: "box-axis recipe base is scanned for hardcoded inline padding",
      code: `import { tv } from "tailwind-variants";
export const recipe = tv({
  base: "w-full px-2.5",
  variants: { box: { control: "h-(--control-h-md)" } },
});
`,
      errors: [error],
    },
    {
      name: "cn string in the same call as a --control-h- pin flags hardcoded height",
      code: `export const popup = cn("*:data-[slot=input-group]:h-8 min-h-(--control-h-md)");
`,
      errors: [error],
    },
    {
      name: "S9: cn popup height literal is flagged when the file pins --control-h- elsewhere",
      code: `export const pin = "h-(--control-h-md)";
export const popup = cn("*:data-[slot=input-group]:h-8");
`,
      errors: [error],
    },
    {
      name: "cn string beside a --control-h- pin flags hardcoded inline padding",
      code: `export const chips = cn("flex min-h-(--control-h-md) px-2");
`,
      errors: [error],
    },
    {
      name: "S9: date-field slot padding is flagged when the file pins --control-h-",
      code: `import { tv } from "tailwind-variants";
/** field box pins h-(--control-h-md) */
export const recipe = tv({
  slots: { input: "text-sm block min-w-[150px] px-2 py-1.5" },
});
`,
      errors: [error],
    },
    {
      name: "tv slot padding is flagged when the slot sits beside a --control-* pin",
      code: `import { tv } from "tailwind-variants";
/** field box pins h-(--control-h-md) */
export const recipe = tv({
  slots: { input: "px-2 [font-size:var(--control-text)]" },
});
`,
      errors: [error],
    },
    {
      name: "Button-size-keyed record flags a literal square ladder",
      code: `const iconButtonSizes = {
  "icon-xs": "size-6",
  "icon-sm": "size-8",
  icon: "size-9",
};
`,
      errors: [error, error, error],
    },
  ],
});
