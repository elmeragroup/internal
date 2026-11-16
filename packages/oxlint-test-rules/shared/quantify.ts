import type { Alt } from "./value.ts";

/*
 * The one rule every consumer applies to a value's alternatives. A value the evaluator cannot
 * know (`unknown`) is never evidence: not for an exemption, and not for a violation, so a
 * consumer's `violates` returns `false` for it.
 */

/**
 * Whether a value is a violation: any one of its alternatives violates.
 *
 * @param alternatives - Every value the expression may hold, or one reading per alternative (a
 *   name, a spelling).
 * @param violates - Whether one alternative violates.
 * @returns Whether the value violates.
 */
export function anyViolates<T>(
  alternatives: ReadonlyArray<T>,
  violates: (alternative: T) => boolean
): boolean {
  return alternatives.some((alternative) => violates(alternative));
}

/**
 * The violation a value makes, for a report that names it: the first alternative's, in order.
 * A value violates when any alternative does, as `anyViolates` decides.
 *
 * @template T - One alternative.
 * @template R - What a violating alternative reports, such as a hook's name or a setting.
 * @param alternatives - Every value the expression may hold.
 * @param violation - What one alternative violates with, or `undefined` when it does not.
 * @returns The first violation, or `undefined` when no alternative violates.
 */
export function firstViolation<T, R>(
  alternatives: ReadonlyArray<T>,
  violation: (alternative: T) => R | undefined
): R | undefined {
  for (const alternative of alternatives) {
    const found = violation(alternative);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Whether a value earns an exemption: it has alternatives, none is `unknown`, and every one
 * qualifies.
 *
 * @param alternatives - Every value the expression may hold.
 * @param qualifies - Whether one alternative qualifies.
 * @returns Whether the value is exempt.
 */
export function allQualify(
  alternatives: ReadonlyArray<Alt>,
  qualifies: (alternative: Alt) => boolean
): boolean {
  return (
    alternatives.length > 0 &&
    alternatives.every((alternative) => alternative.kind !== "unknown" && qualifies(alternative))
  );
}

/**
 * The reading every alternative agrees on, such as the API a callee names in each: an exemption
 * or a `guaranteed` event needs all of them to be the same, and one that names nothing agrees with
 * nothing.
 *
 * @param readings - One reading per alternative, `undefined` for one that has none.
 * @returns The shared reading, or `undefined` when they differ or one is missing.
 */
export function allAgree(readings: ReadonlyArray<string | undefined>): string | undefined {
  const [first, ...rest] = readings;
  return first !== undefined && rest.every((reading) => reading === first) ? first : undefined;
}
