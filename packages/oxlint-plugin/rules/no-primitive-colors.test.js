import { createRuleTester } from "../rule-tester.js";
import noPrimitiveColors from "./no-primitive-colors.js";

const tester = createRuleTester("tsx");
const error = { messageId: "no-primitive-colors" };

tester.run("elmera/no-primitive-colors", noPrimitiveColors, {
  valid: [
    {
      name: "role token",
      code: `const x = "bg-background text-foreground";\n`,
    },
    {
      name: "documented Dialog/Sheet scrim",
      code: `const x = "bg-black/10 supports-backdrop-filter:backdrop-blur-xs";\n`,
    },
    {
      name: "documented Item image hairline",
      code: `const x = "outline-black/10";\n`,
    },
    {
      name: "documented disabledHatch texture",
      code: `const x = "bg-[repeating-linear-gradient(45deg,transparent,transparent_8px,rgb(0_0_0/0.02)_8px,rgb(0_0_0/0.02)_16px)]";\n`,
    },
  ],
  invalid: [
    {
      name: "bg-black/100 is not the documented /10 scrim",
      code: `const x = "bg-black/100";\n`,
      errors: [error],
    },
    {
      name: "hover:bg-black/10 is not the exact allowlisted class",
      code: `const x = "hover:bg-black/10";\n`,
      errors: [error],
    },
    {
      name: "hover:bg-black/100 is not allowlisted",
      code: `const x = "hover:bg-black/100";\n`,
      errors: [error],
    },
    {
      name: "raw palette",
      code: `const x = "bg-white text-slate-500";\n`,
      errors: [error],
    },
  ],
});
