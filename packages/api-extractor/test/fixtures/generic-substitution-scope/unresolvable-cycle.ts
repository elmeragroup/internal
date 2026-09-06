// The cycle is the point: extraction must degrade through the structured
// fallback contract instead of dropping the exports.
// @ts-expect-error - the alias circularly references itself
export type Loop<T> = Loop<T>;
// @ts-expect-error - the erroneous alias above is no longer generic
export type Value = Loop<string>;
