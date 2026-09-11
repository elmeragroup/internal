import { createRuleTester } from "../rule-tester.js";
import noTailwindDarkVariant from "./no-tailwind-dark-variant.js";

const tester = createRuleTester("tsx");
const error = { messageId: "no-tailwind-dark-variant" };

tester.run("elmera/no-tailwind-dark-variant", noTailwindDarkVariant, {
  valid: [
    {
      name: `"bg-background text-foreground" literal`,
      code: `const x = "bg-background text-foreground";\n`,
    },
    {
      name: `"darkish:bg-red-500" is not the dark axis`,
      code: `const x = "darkish:bg-red-500";\n`,
    },
    {
      name: `"dark-mode text-dark" has no variant colon`,
      code: `const x = "dark-mode text-dark";\n`,
    },
    {
      name: `"dark:" bare token with no utility`,
      code: `const x = "dark:";\n`,
    },
    {
      name: `"[content:'dark:literal']" dark text inside an arbitrary value`,
      code: `const x = "[content:'dark:literal']";\n`,
    },
    {
      name: `"before:content-['dark:x']" dark text inside brackets after a variant`,
      code: `const x = "before:content-['dark:x']";\n`,
    },
    {
      name: `"bg-[url(a:b)] dark\\:escaped" escaped colon is not a variant`,
      code: `const x = "bg-[url(a:b)] dark\\\\:escaped";\n`,
    },
    {
      name: `"dark-mode" className attribute`,
      code: `const el = <div className="dark-mode" />;\n`,
    },
    {
      name: `"data-dark:bg-red-500" named data variant is not the dark axis`,
      code: `const x = "data-dark:bg-red-500";\n`,
    },
    {
      name: `"theme-dark:bg-red-500" custom named variant is not the dark axis`,
      code: `const x = "theme-dark:bg-red-500";\n`,
    },
    {
      name: `"hover:data-dark:bg-red-500" named data variant after another variant`,
      code: `const x = "hover:data-dark:bg-red-500";\n`,
    },
    {
      name: `\`dark-\${tone}\` template is not a variant`,
      code: "const x = `dark-${tone}`;\n",
    },
  ],
  invalid: [
    {
      name: `"dark:bg-red-500" literal`,
      code: `const x = "dark:bg-red-500";\n`,
      errors: [error],
    },
    {
      name: `"dark:bg-red-500!" trailing important`,
      code: `const x = "dark:bg-red-500!";\n`,
      errors: [error],
    },
    {
      name: `"not-dark:bg-red-500" compound dark axis`,
      code: `const x = "not-dark:bg-red-500";\n`,
      errors: [error],
    },
    {
      name: `"dark:[color:red]" arbitrary property`,
      code: `const x = "dark:[color:red]";\n`,
      errors: [error],
    },
    {
      name: `"dark:!bg-red-500" important prefix`,
      code: `const x = "dark:!bg-red-500";\n`,
      errors: [error],
    },
    {
      name: `"dark:-mt-1" negative utility`,
      code: `const x = "dark:-mt-1";\n`,
      errors: [error],
    },
    {
      name: `"hover:dark:[color:red]" stacked variant plus arbitrary value`,
      code: `const x = "hover:dark:[color:red]";\n`,
      errors: [error],
    },
    {
      name: `"dark:[&>span]:text-red-500" arbitrary variant after dark`,
      code: `const x = "dark:[&>span]:text-red-500";\n`,
      errors: [error],
    },
    {
      name: `"[&:hover]:dark:text-red-500" colon inside brackets before dark`,
      code: `const x = "[&:hover]:dark:text-red-500";\n`,
      errors: [error],
    },
    {
      name: `"flex dark:bg-red-500 p-2" dark token in a class list`,
      code: `const x = "flex dark:bg-red-500 p-2";\n`,
      errors: [error],
    },
    {
      name: `"dark:[color:red]" className attribute`,
      code: `const el = <div className="dark:[color:red]" />;\n`,
      errors: [error],
    },
    {
      name: `"dark:!bg-red-500" className expression`,
      code: `const el = <div className={cn("p-2", "dark:!bg-red-500")} />;\n`,
      errors: [error],
    },
    {
      name: `\`flex \${gap} dark:-mt-1\` template literal`,
      code: "const x = `flex ${gap} dark:-mt-1`;\n",
      errors: [error],
    },
    {
      name: `"[aria-label='😀']:dark:bg-red-500" non-BMP arbitrary variant before dark`,
      code: `const x = "[aria-label='😀']:dark:bg-red-500";\n`,
      errors: [error],
    },
  ],
});
