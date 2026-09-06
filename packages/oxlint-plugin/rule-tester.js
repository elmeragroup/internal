import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

RuleTester.describe = describe;
RuleTester.it = it;

/**
 * @param {"ts" | "tsx"} [lang]
 */
export function createRuleTester(lang = "ts") {
  return new RuleTester({ languageOptions: { parserOptions: { lang } } });
}
