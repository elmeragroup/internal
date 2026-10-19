import { createRuleTester } from "../rule-tester.js";
import noRacOutsideQuarantine from "./no-rac-outside-quarantine.js";

const tester = createRuleTester();
const error = { messageId: "quarantined" };

tester.run("elmera/no-rac-outside-quarantine", noRacOutsideQuarantine, {
  valid: [
    {
      name: "react-aria-components inside quarantine",
      filename: "packages/fuse/src/react-aria/calendar.ts",
      code: `import { Calendar } from "react-aria-components";
`,
    },
    {
      name: "react-aria inside quarantine",
      filename: "packages/fuse/src/react-aria/focusable.ts",
      code: `import { useFocusable } from "react-aria";
`,
    },
    {
      name: "@internationalized/date inside quarantine",
      filename: "packages/fuse/src/react-aria/date-field.ts",
      code: `import { parseDate } from "@internationalized/date";
`,
    },
    {
      name: "unrelated import in components",
      filename: "packages/fuse/src/components/button/button.tsx",
      code: `import { Button as ButtonPrimitive } from "@base-ui/react/button";
`,
    },
    {
      name: "scoped @react-aria inside quarantine",
      filename: "packages/fuse/src/react-aria/focusable.ts",
      code: `import { useFocusable } from "@react-aria/focus";
`,
    },
    {
      name: "nested file inside quarantine",
      filename: "packages/fuse/src/react-aria/grid-list/grid-list.tsx",
      code: `import { GridList } from "react-aria-components";
`,
    },
    {
      name: "named re-export inside quarantine",
      filename: "packages/fuse/src/react-aria/calendar.ts",
      code: `export { Calendar } from "react-aria-components";
`,
    },
    {
      name: "star re-export inside quarantine",
      filename: "packages/fuse/src/react-aria/focusable.ts",
      code: `export * from "react-aria";
`,
    },
    {
      name: "dynamic import inside quarantine",
      filename: "packages/fuse/src/react-aria/calendar.ts",
      code: `const load = () => import("react-aria-components");
`,
    },
    {
      name: "quarantine under a Windows path",
      filename: "C:\\repo\\packages\\fuse\\src\\react-aria\\focusable.ts",
      code: `import { useFocusable } from "react-aria";
`,
    },
    {
      name: "dynamic import of an allowed module in components",
      filename: "packages/fuse/src/components/button/button.tsx",
      code: `const load = () => import("@base-ui/react/button");
`,
    },
    {
      name: "computed dynamic import is not a specifier",
      filename: "packages/fuse/src/components/select/select.tsx",
      code: `const load = (path) => import(path);
`,
    },
  ],
  invalid: [
    {
      name: "react-aria-components from components",
      filename: "packages/fuse/src/components/select/select.tsx",
      code: `import { Select } from "react-aria-components";
`,
      errors: [error],
    },
    {
      name: "react-aria from components",
      filename: "packages/fuse/src/components/button/button.tsx",
      code: `import { useFocusable } from "react-aria";
`,
      errors: [error],
    },
    {
      name: "@internationalized/date from components",
      filename: "packages/fuse/src/components/input/input.tsx",
      code: `import { parseDate } from "@internationalized/date";
`,
      errors: [error],
    },
    {
      name: "scoped @react-aria from components",
      filename: "packages/fuse/src/components/button/button.tsx",
      code: `import { useButton } from "@react-aria/button";
`,
      errors: [error],
    },
    {
      name: "scoped @react-stately from components",
      filename: "packages/fuse/src/components/select/select.tsx",
      code: `import { useSelectState } from "@react-stately/select";
`,
      errors: [error],
    },
    {
      name: "named re-export from components",
      filename: "packages/fuse/src/components/select/index.ts",
      code: `export { Select } from "react-aria-components";
`,
      errors: [error],
    },
    {
      name: "star re-export from components",
      filename: "packages/fuse/src/components/select/index.ts",
      code: `export * from "react-aria";
`,
      errors: [error],
    },
    {
      name: "dynamic import of react-aria-components from components",
      filename: "packages/fuse/src/components/select/select.tsx",
      code: `const load = () => import("react-aria-components");
`,
      errors: [error],
    },
    {
      name: "the former packages/ui root is no longer the quarantine",
      filename: "packages/ui/src/react-aria/focusable.ts",
      code: `import { useFocusable } from "react-aria";
`,
      errors: [error],
    },
    {
      name: "a react-aria directory in another package is not the quarantine",
      filename: "packages/other/src/react-aria/widget.ts",
      code: `import { useFocusable } from "react-aria";
`,
      errors: [error],
    },
    {
      name: "a react-aria directory outside src is not the quarantine",
      filename: "packages/fuse/test/react-aria/widget.ts",
      code: `import { useFocusable } from "react-aria";
`,
      errors: [error],
    },
    {
      name: "a package whose name starts with fuse is not the quarantine",
      filename: "packages/fuse-old/src/react-aria/widget.ts",
      code: `import { useFocusable } from "react-aria";
`,
      errors: [error],
    },
    {
      name: "a package whose name ends in fuse is not the quarantine",
      filename: "packages/not-fuse/src/react-aria/widget.ts",
      code: `import { useFocusable } from "react-aria";
`,
      errors: [error],
    },
    {
      name: "a bare src/react-aria path is not the quarantine without the package root",
      filename: "src/react-aria/widget.ts",
      code: `import { useFocusable } from "react-aria";
`,
      errors: [error],
    },
  ],
});
