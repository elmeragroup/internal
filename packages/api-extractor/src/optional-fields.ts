/**
 * Optional model-field builders. Absent keys stay absent under
 * `exactOptionalPropertyTypes`; this is the only place the extractor omits
 * fields by dropping undefined values or keeping only `true` flags.
 */

/** Required keys stay required; keys that admit `undefined` become optional and drop that union member. */
export type DefinedFields<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Drops keys whose value is `undefined`. */
export function definedFields<T extends object>(fields: T): DefinedFields<T> {
  const defined = Object.fromEntries(Object.entries(fields).filter((entry) => entry[1] !== undefined));
  // SAFETY: Object.entries loses key/value correlation; the filter is the omission contract.
  return defined as DefinedFields<T>;
}

/** Keeps only the flags that are `true`. */
export function flagFields<T extends { readonly [K in keyof T]: boolean }>(
  flags: T
): { readonly [K in keyof T]?: true } {
  const present = Object.fromEntries(
    Object.entries(flags)
      .filter((entry) => entry[1] === true)
      .map((entry) => [entry[0], true as const])
  );
  // SAFETY: Object.entries loses key/value correlation; keeping only `true` is the omission contract.
  return present as { readonly [K in keyof T]?: true };
}
