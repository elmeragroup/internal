import { RuleTester } from "oxlint/plugins-dev";

export function createRuleTester(lang: "ts" | "tsx" = "ts"): RuleTester {
  return new RuleTester({ languageOptions: { parserOptions: { lang } } });
}
