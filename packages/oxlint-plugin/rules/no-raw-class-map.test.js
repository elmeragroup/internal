import { createRuleTester } from "../rule-tester.js";
import noRawClassMap from "./no-raw-class-map.js";

const tester = createRuleTester("tsx");
const error = { messageId: "rawClassMap" };
const component = "packages/ui/src/components/card/card.tsx";
const docs = "apps/docs/src/components/header.tsx";
const intl = "packages/ui/src/components/overlay/intl/en-US.ts";
const generated = "apps/docs/src/generated/theme-catalog.ts";
const testFile = "packages/ui/src/components/card/card.test.ts";
const typeTest = "packages/ui/src/components/card/card.test-d.tsx";

tester.run("elmera/no-raw-class-map", noRawClassMap, {
  valid: [
    {
      name: "tv({ variants }) accepted",
      filename: component,
      code: `import { tv } from "tailwind-variants";
const recipe = tv({
  variants: {
    size: { sm: "text-sm", md: "text-base" },
  },
  defaultVariants: { size: "sm" },
});
`,
    },
    {
      name: "cn(…) accepted",
      filename: component,
      code: `const className = cn("flex items-center gap-2 text-sm font-medium");
`,
    },
    {
      name: "call-expression init accepted",
      filename: component,
      code: `const className = joinClasses("flex items-center gap-2 text-sm font-medium");
`,
    },
    {
      name: "named cn() constant accepted",
      filename: "packages/ui/src/components/dropdown-menu/dropdown-menu.tsx",
      code: `const dropdownMenuItemClassName = cn(
  selfFocusRingClass,
  menuItemClass,
  "group/dropdown-menu-item px-2 focus:bg-accent"
);
`,
    },
    {
      name: "recipe-derived recipe().slot() accepted",
      filename: "packages/ui/src/styles/utils.ts",
      code: `export const selfFocusRingClass = focusRing({ target: "self" }).root();
`,
    },
    {
      name: "recipe-derived itemVariants() accepted",
      filename: "packages/ui/src/components/selection-item/selection-item.tsx",
      code: `const outlineItemClass = itemVariants({ variant: "outline" });
`,
    },
    {
      name: "recipe-derived slots.base() accepted",
      filename: "packages/ui/src/react-aria/internal/popover.tsx",
      code: `const popoverSlots = popoverVariants();
const popoverBaseClass = popoverSlots.base();
`,
    },
    {
      name: "test file ignored",
      filename: testFile,
      code: `const VARIANT_CLASS = { default: "text-sm bg-card flex gap-2" } as const;
const BASE_CLASSES = "text-xs leading-relaxed max-h-160 overflow-auto font-mono";
`,
    },
    {
      name: "type-test file ignored",
      filename: typeTest,
      code: `const TITLE_SIZE_CLASSES = { sm: "text-sm" } as const;
`,
    },
    {
      name: "intl dictionary filename ignored",
      filename: intl,
      code: `export const enUS = { close: "Close", open: "Open" };
`,
    },
    {
      name: "generated path ignored",
      filename: generated,
      code: `export const catalog = { root: "flex gap-2 text-sm" } as const;
`,
    },
    {
      name: "overlayLayer z-50 keep is not a class map",
      filename: "packages/ui/src/components/overlay/overlay-classes.ts",
      code: `export const overlayLayer = "z-50";
`,
    },
    {
      name: "non-class map of enums stays quiet",
      filename: "packages/ui/src/components/meter/meter-constants.ts",
      code: `const METER_CONSTANTS = {
  MODES: { DEFAULT: "default", INVERTED: "inverted" },
  LEVELS: { LOW: "LOW", FULL: "FULL" },
} as const;
`,
    },
    {
      name: "non-class map of swipe directions stays quiet",
      filename: "packages/ui/src/components/sheet/sheet.tsx",
      code: `export const SIDE_TO_SWIPE_DIRECTION = {
  top: "up",
  right: "right",
  bottom: "down",
  left: "left",
} as const;
`,
    },
    {
      name: "component constructor map stays quiet",
      filename: "packages/ui/src/components/alert/alert.tsx",
      code: `const ALERT_ICONS = {
  default: Info,
  warning: Warning,
  success: CheckCircle,
} as const;
`,
    },
    {
      name: "oklch token constants stay quiet",
      filename: "packages/ui/src/theme/tokens/defaults.ts",
      code: `const INTERNAL_FOREGROUND = "oklch(0.15 0.0041 49.31)";
export const DEFAULTS = { background: WHITE, foreground: INTERNAL_FOREGROUND } as const;
`,
    },
    {
      name: "docs non-class string constants stay quiet",
      filename: docs,
      code: `export const MAIN_CONTENT_ID = "main-content";
const HREF = "/handbook/theming";
const LANGUAGE_CLASS = "language-";
`,
    },
    {
      name: "generated-file comment with the word block stays quiet",
      filename: "packages/ui/src/theme/generate-demo-stage-css.ts",
      code: `const GENERATED_FILE_HEADER = \`/**
 * AUTO-GENERATED FILE — DO NOT EDIT DIRECTLY.
 *
 * Re-scopes the library :root[data-density="comfortable"] block onto .DemoStage.
 */
\`;
`,
    },
  ],
  invalid: [
    {
      name: "object map flagged",
      filename: component,
      code: `const TITLE_SIZE_CLASSES = { sm: "text-sm", lg: "text-lg" } as const;
`,
      errors: [error],
    },
    {
      name: "satisfies object map flagged",
      filename: "packages/ui/src/components/radio-group/radio-group.tsx",
      code: `const iconButtonSizes = {
  icon: "size-(--control-h-md) [&_svg:not([class*='size-'])]:size-4",
} as const satisfies Record<string, string>;
`,
      errors: [error],
    },
    {
      name: "nested map flagged",
      filename: "packages/ui/src/components/selection-item/selection-item.tsx",
      code: `export const selectionGroupOrientationClass = {
  group: { vertical: "flex flex-col gap-2", horizontal: "flex flex-wrap gap-4" },
  list: { vertical: "gap-0", horizontal: "flex-row flex-wrap gap-4" },
} as const satisfies Record<"group" | "list", Record<string, string>>;
`,
      errors: [error],
    },
    {
      name: "bare string flagged",
      filename: "packages/ui/src/components/overlay/overlay-classes.ts",
      code: `export const overlayTitleClass = "text-base font-medium font-heading leading-none text-balance";
`,
      errors: [error],
    },
    {
      name: "1-token hatch-style bg-[…] flagged",
      filename: "packages/ui/src/styles/utils.ts",
      code: `export const disabledHatch =
  "bg-[repeating-linear-gradient(45deg,transparent,transparent_8px,rgb(0_0_0/0.02)_8px,rgb(0_0_0/0.02)_16px)]";
`,
      errors: [error],
    },
    {
      name: "2-token class string flagged",
      filename: "packages/ui/src/components/field/field-frame.tsx",
      code: `export const fieldFrameDescriptionClass = "text-sm text-pretty";
`,
      errors: [error],
    },
    {
      name: "docs-app filename flagged",
      filename: docs,
      code: `const classNames = { root: "sticky top-0 flex items-center gap-6" } as const;
`,
      errors: [error],
    },
    {
      name: "template composing class constants flagged",
      filename: "packages/ui/src/components/overlay/overlay-classes.ts",
      code: `export const overlayPositionerClass = \`isolate \${overlayLayer}\`;
export const overlayTimedPopupClass = \`\${overlayPopupSurfaceClass} \${overlayPopupMotionClass} \${overlayPopupDurationClass}\`;
`,
      errors: [error, error],
    },
    {
      name: "1-token duration utility flagged",
      filename: "packages/ui/src/components/overlay/overlay-classes.ts",
      code: `export const overlayPopupDurationClass = "duration-100";
`,
      errors: [error],
    },
    {
      name: "icon-crossfade tokens flagged",
      filename: "packages/ui/src/styles/utils.ts",
      code: `export const iconCrossfadeShown = "blur-0 scale-100 opacity-100";
`,
      errors: [error],
    },
  ],
});
