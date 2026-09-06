import { createRuleTester } from "../rule-tester.js";
import restrictPackageRootFromScript from "./restrict-package-root-from-script.js";

const tester = createRuleTester();
const error = { messageId: "usePackageRootFromScript" };
const paths = "packages/ui/scripts/paths.ts";
const script = "packages/ui/scripts/size-limit.ts";

tester.run("elmera/restrict-package-root-from-script", restrictPackageRootFromScript, {
  valid: [
    {
      name: "paths.ts may derive the package root",
      filename: paths,
      code: `export function packageRootFromScript(scriptUrl) {
  return join(dirname(fileURLToPath(scriptUrl)), "..");
}
`,
    },
    {
      name: "scripts call packageRootFromScript",
      filename: script,
      code: `const packageRoot = packageRootFromScript(import.meta.url);
`,
    },
  ],
  invalid: [
    {
      name: "scripts may not inline dirname(fileURLToPath(import.meta.url))",
      filename: script,
      code: `const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
`,
      errors: [error],
    },
  ],
});
