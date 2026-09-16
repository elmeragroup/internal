import { RuleTester } from "oxlint/plugins-dev";

/**
 * Create the RuleTester shared by the anti-slop rule suites.
 *
 * @param lang - The parser language, `ts` by default or `tsx` for JSX cases.
 * @returns A RuleTester configured for the requested language.
 */
export function createRuleTester(lang: "ts" | "tsx" = "ts"): RuleTester {
  return new RuleTester({ languageOptions: { parserOptions: { lang } } });
}
