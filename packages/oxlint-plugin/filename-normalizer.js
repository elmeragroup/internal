/**
 * Normalize a filename to forward slashes so the same path checks behave on
 * every platform.
 *
 * @param {string} filename - The filename as reported by the linter.
 * @returns {string} The filename with `\` replaced by `/`.
 */
export function normalizeFilename(filename) {
  return filename.replaceAll("\\", "/");
}

/**
 * Whether a filename is a test file: `<name>.test.ts`, `<name>.test.tsx`, or
 * `<name>.test-d.tsx`. A `.browser.test.tsx` filename already ends with
 * `.test.tsx`, so it needs no arm of its own.
 *
 * @param {string} filename - The filename as reported by the linter.
 * @returns {boolean} `true` for `<name>.test.ts`, `<name>.test.tsx`, and
 * `<name>.test-d.tsx`.
 */
export function isTestFile(filename) {
  const normalized = normalizeFilename(filename);
  return (
    normalized.endsWith(".test.ts") || normalized.endsWith(".test.tsx") || normalized.endsWith(".test-d.tsx")
  );
}
