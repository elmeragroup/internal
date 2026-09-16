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
    {
      name: "role tokens in a className attribute",
      code: `const x = <div className="bg-background text-foreground" />;\n`,
    },
    {
      name: "role tokens in a cn call inside a className attribute",
      code: `const x = <div className={cn("bg-background", "text-foreground")} />;\n`,
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
    {
      name: "raw palette literal in a className attribute reports once",
      code: `const x = <div className="bg-white" />;\n`,
      errors: [error],
    },
    {
      name: "raw palette expression in a className attribute reports once",
      code: `const x = <div className={"bg-white text-slate-500"} />;\n`,
      errors: [error],
    },
    {
      name: "raw palette template in a className attribute reports once",
      code: "const x = <div className={`bg-white ${label}`} />;\n",
      errors: [error],
    },
    {
      name: "raw palette cn call in a className attribute reports once",
      code: `const x = <div className={cn("bg-white")} />;\n`,
      errors: [error],
    },
    {
      name: "raw palette cn call outside JSX reports once",
      code: `const x = cn("bg-white", "text-slate-500");\n`,
      errors: [error],
    },
    {
      name: "raw palette template literal reports once",
      code: "const x = `text-slate-500 ${label}`;\n",
      errors: [error],
    },
    {
      name: "raw palette tv call reports once",
      code: `const x = tv({ base: "bg-white" });\n`,
      errors: [error],
    },
  ],
});
