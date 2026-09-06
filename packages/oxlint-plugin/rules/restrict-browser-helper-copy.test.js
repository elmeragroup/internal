import { createRuleTester } from "../rule-tester.js";
import restrictBrowserHelperCopy from "./restrict-browser-helper-copy.js";

const tester = createRuleTester("tsx");
const error = (helper) => ({ messageId: "localCopy", data: { helper } });
const owner = "packages/ui/test/themed-browser-render.tsx";
const suite = "packages/ui/src/components/show/show.browser.test.tsx";

tester.run("elmera/restrict-browser-helper-copy", restrictBrowserHelperCopy, {
  valid: [
    {
      name: "the harness may declare the shared queries",
      filename: owner,
      code: `export function roleNamed(role, name) {}
export function headingNamed(name) {}
export function cssVarColor(host, token) {}
export function textNamed(name) {}
export function textboxNamed(name) {}
export function stampDensity(density) {}
export function px(value) {}
`,
    },
    {
      name: "suites may call the shared queries",
      filename: suite,
      code: `const button = roleNamed("button", "Save");
const heading = headingNamed("Title");
const color = cssVarColor(host, "--primary");
const label = textNamed("Body");
const field = textboxNamed("Email");
stampDensity("comfortable");
const width = px(getComputedStyle(host).width);
`,
    },
    {
      name: "destructuring a shared query name is not a declaration",
      filename: suite,
      code: `const { px } = harness;
`,
    },
  ],
  invalid: [
    {
      name: "suite may not declare function roleNamed",
      filename: suite,
      code: `function roleNamed() {}
`,
      errors: [error("roleNamed")],
    },
    {
      name: "suite may not assign const headingNamed",
      filename: suite,
      code: `const headingNamed = () => undefined;
`,
      errors: [error("headingNamed")],
    },
    {
      name: "suite may not assign let cssVarColor",
      filename: suite,
      code: `let cssVarColor = () => "";
`,
      errors: [error("cssVarColor")],
    },
    {
      name: "suite may not assign const textNamed",
      filename: suite,
      code: `const textNamed = (name) => page.getByText(name).element();
`,
      errors: [error("textNamed")],
    },
    {
      name: "suite may not declare function textboxNamed",
      filename: suite,
      code: `function textboxNamed(name) {}
`,
      errors: [error("textboxNamed")],
    },
    {
      name: "suite may not declare function stampDensity",
      filename: suite,
      code: `function stampDensity(density) {}
`,
      errors: [error("stampDensity")],
    },
    {
      name: "suite may not assign const px",
      filename: suite,
      code: `const px = (value) => Number.parseFloat(value);
`,
      errors: [error("px")],
    },
  ],
});
