// This fixture verifies compiler-equivalent `.js` declaration resolution for
// a type-only star re-export.
export type * from "./source.js";
export { RuntimeValue } from "./source.js";
