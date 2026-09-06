/**
 * React Aria packages restricted to the quarantine directory, including
 * their `@react-aria/*` and `@react-stately/*` dependencies.
 *
 * Package-owned policy used by `elmera/no-rac-outside-quarantine`.
 *
 * @type {readonly string[]}
 */
export const FORBIDDEN_RAC_PACKAGES = Object.freeze([
  "react-aria-components",
  "react-aria",
  "@internationalized/date",
  "@react-aria",
  "@react-stately",
]);

/**
 * @param {string} specifier
 * @returns {boolean}
 */
export function isForbiddenRacSpecifier(specifier) {
  for (const name of FORBIDDEN_RAC_PACKAGES) {
    if (specifier === name || specifier.startsWith(`${name}/`)) {
      return true;
    }
  }
  return false;
}
