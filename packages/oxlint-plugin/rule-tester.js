import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

RuleTester.describe = describe;
RuleTester.it = it;

/**
 * Create a rule tester for one parser language, with Vitest's `describe`/`it`
 * wired into RuleTester at module load.
 *
 * @param {"ts" | "tsx"} [lang] - The parser language; defaults to `ts`.
 * @returns {RuleTester} A tester that runs rules under Vitest.
 */
export function createRuleTester(lang = "ts") {
  return new RuleTester({ languageOptions: { parserOptions: { lang } } });
}
