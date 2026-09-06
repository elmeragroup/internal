/**
 * Project declarations that carry the built-in array names without being the
 * built-in arrays. Importing them shadows the global names in the importing
 * file, which is what makes a name-text gate replay the wrong element syntax.
 */

/** A project `Array` whose element type has nothing to do with its parameter. */
export type Array<Item> = string[];

/** A project `ReadonlyArray` whose element type ignores its parameter as well. */
export type ReadonlyArray<Item> = string[];
