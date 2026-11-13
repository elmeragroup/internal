import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

RuleTester.describe = describe;
RuleTester.it = it;

/**
 * The globals the repo's config declares for test files (`env: { builtin: true }` plus the host and
 * browser globals tests read), so a rule meets a global here the way it does under `pnpm lint`:
 * as a variable with no definition, not as an unbound name.
 */
const GLOBALS = {
  Array: "readonly",
  Date: "readonly",
  JSON: "readonly",
  Math: "readonly",
  Promise: "readonly",
  globalThis: "readonly",
  performance: "readonly",
  process: "readonly",
  self: "readonly",
  setTimeout: "readonly",
  window: "readonly",
} as const;

/**
 * A RuleTester that reports through Vitest and parses every case as TSX module code unless the
 * case names its own file.
 */
export const ruleTester = new RuleTester({
  languageOptions: { sourceType: "module", parserOptions: { lang: "tsx" }, globals: GLOBALS },
});
