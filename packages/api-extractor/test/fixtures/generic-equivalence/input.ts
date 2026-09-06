/**
 * Unions of enclosing callbacks whose nested generic signatures must stay
 * distinct unless they are alpha-equivalent.
 *
 * Direct generic functions with different constraints already compare
 * structurally. Nesting them under object properties is the shape that used
 * to collapse through render identity. Inner-versus-outer parameter references
 * used to compare equal through a one-sided rename map.
 */

export type DistinctNestedConstraints =
  | ((handler: { fn: <T extends string>(value: T) => T }) => void)
  | ((handler: { fn: <T extends number>(value: T) => T }) => void);

export type DistinctNestedDefaults =
  | ((handler: { fn: <T extends string | number = string>(value: T) => T }) => void)
  | ((handler: { fn: <T extends string | number = number>(value: T) => T }) => void);

export type AlphaRenamedControls =
  | ((handler: { fn: <T extends string>(value: T) => T }) => void)
  | ((handler: { fn: <U extends string>(value: U) => U }) => void);

export type InnerVersusOuter =
  | (<T>(value: <T>(value: T) => T) => void)
  | (<U>(value: <V>(value: U) => V) => void);

export type EquivalentShadowing =
  | (<T>(value: <T>(value: T) => T) => void)
  | (<U>(value: <V>(value: V) => V) => void);
