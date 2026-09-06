/** An element carried by the containers in this fixture. */
export interface Element {
  /** The element's identifier. */
  id: string;
}

/** A tuple whose open rest element is a `keyof` over a type parameter. */
export type OpenRestKeys<Target> = [string, ...(keyof Target)[]];

/** The same open rest written as a built-in array reference. */
export type OpenRestKeysReference<Target> = [string, ...Array<keyof Target>];

/** A tuple whose rest element is a finite inline spread. */
export type FiniteSpreadKeys<Target> = [boolean, ...[keyof Target, number]];

/** A tuple whose rest element is a finite spread declared as an alias. */
export type AliasedSpread<Target> = [boolean, ...SpreadTail<Target>];

/** The finite tail an aliased spread expands to. */
export type SpreadTail<Target> = [keyof Target, number];

/** A tuple whose rest element is an array of arrays. */
export type NestedRest = [string, ...Element[][]];

/** An alias whose body is a `keyof`, reached without authored operator syntax. */
export type Keys<Target> = keyof Target;

/** A tuple element that names the alias instead of writing `keyof` itself. */
export type AliasedKeys<Target> = [Keys<Target>];

/** A parameterless alias of a tuple, whose elements are not type arguments. */
export type Pair = [string, number];

/** A parameterless alias of an array reference, for the same reason. */
export type Names = Array<string>;

/** A generic alias of a tuple, which does have one type argument. */
export type GenericPair<Item> = [Item, number];

/** An instantiation of that generic alias. */
export type InstantiatedPair = GenericPair<string>;

/** A `keyof` the checker already reduced to the keys it can name. */
export type ElementKeys = keyof Element;

/** Library interfaces that keep their authored names. */
export interface LibraryContainers {
  /** A promise of a string. */
  promise: Promise<string>;
  /** A map keyed by string. */
  lookup: Map<string, number>;
  /** A conditional library alias the checker resolves away. */
  parameters: Parameters<(first: string) => void>;
}

/** A type declaring both of the index signatures TypeScript allows. */
export type DualIndexed = {
  [name: string]: Element;
  [position: number]: Element;
};

/** A type declaring an index signature the semantic model cannot represent. */
export type SymbolIndexed = { [key: symbol]: Element };

// Each spread must keep the donor parameter environment belonging to that occurrence.
type EnvironmentTail<T> = [T, keyof T];
export type TwoEnvironments = [...EnvironmentTail<{ first: 1 }>, ...EnvironmentTail<{ second: 2 }>];
export type DirectEnvironments = [{ first: 1 }, keyof { first: 1 }, { second: 2 }, keyof { second: 2 }];
export type RenamedEnvironment<U> = [...EnvironmentTail<U>];
export type DirectRenamedEnvironment<U> = [U, keyof U];
type NestedEnvironment<U> = [...EnvironmentTail<U>, ...EnvironmentTail<U>];
export type RepeatedEnvironment = [...NestedEnvironment<{ nested: 3 }>];
export type DirectRepeatedEnvironment = [{ nested: 3 }, keyof { nested: 3 }, { nested: 3 }, keyof { nested: 3 }];
