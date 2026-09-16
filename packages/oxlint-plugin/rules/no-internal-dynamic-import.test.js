import { createRuleTester } from "../rule-tester.js";
import noInternalDynamicImport from "./no-internal-dynamic-import.js";

const tester = createRuleTester();
const error = { messageId: "noDynamicImport" };

tester.run("elmera/no-internal-dynamic-import", noInternalDynamicImport, {
  valid: [
    {
      name: "static import",
      code: `import { Button } from "./button";
`,
    },
    {
      name: "static type import",
      code: `import type { ButtonProps } from "./button";
`,
    },
    {
      name: "static re-export",
      code: `export { Button } from "./button";
`,
    },
    {
      name: "import.meta is not a dynamic module load",
      code: `const url = import.meta.url;
`,
    },
  ],
  invalid: [
    {
      name: "top-level dynamic import",
      code: `const load = await import("./button");
`,
      errors: [error],
    },
    {
      name: "dynamic import inside a function",
      code: `async function load() {
  return import("./button");
}
`,
      errors: [error],
    },
    {
      name: "dynamic import with a computed specifier",
      code: `const load = (path) => import(path);
`,
      errors: [error],
    },
  ],
});
