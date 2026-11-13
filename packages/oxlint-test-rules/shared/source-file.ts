/**
 * Whether a linted file is a test: `*.test.ts`, `*.test.tsx`, `*.test-d.tsx` or `*.test.mjs`. The
 * source contracts bind library modules; a test may import or spell anything it checks.
 *
 * @param filename - The filename the linter reports, with either path separator.
 * @returns Whether the file is a test file.
 */
export function isTestFile(filename: string): boolean {
  return /\.test(?:-d)?\.[cm]?[jt]sx?$/u.test(filename);
}
