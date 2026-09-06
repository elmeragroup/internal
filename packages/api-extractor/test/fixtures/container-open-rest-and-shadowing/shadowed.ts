import type { Array, ReadonlyArray } from "./shadowed-array";

/** An element type that must never be reported as an array's element. */
export interface Marker {
  /** The marker's identifier. */
  id: string;
}

/** An array written through a project alias that shadows the built-in name. */
export type ShadowedArrayElements = Array<Marker>;

/** An open rest that spreads a project alias shadowing the readonly built-in. */
export type ShadowedRestElements = [boolean, ...ReadonlyArray<Marker>];

/** A project alias whose body is an array of something else entirely. */
export type StringArray<Item> = string[];

/** An array reached through that alias, whose element is a string. */
export type MislabeledElements = StringArray<Marker>;

/** An open rest that spreads the same alias. */
export type MislabeledRestElements = [boolean, ...StringArray<Marker>];
