/**
 * Whether a linted file is a test, as Vitest and Playwright find one by default: `*.test.*` or
 * `*.spec.*` (`button.test.tsx`, `checkout.spec.ts`, `types.test-d.ts`, `setup.test.mjs`). The
 * source contracts bind library modules; a test may import or spell anything it checks.
 *
 * @param filename - The filename the linter reports, with either path separator.
 * @returns Whether the file is a test file.
 */
export function isTestFile(filename: string): boolean {
  return /\.(?:test|spec)(?:-d)?\.[cm]?[jt]sx?$/u.test(filename);
}
