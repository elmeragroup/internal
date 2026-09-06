// A three-file module re-export chain: input forwards through middle to the
// origin declaration. Provenance records every intermediate forwarding file
// outermost first (`input.ts`, then `middle.ts`) while `declarationPaths`
// keep the origin.
export { ping } from "./middle";
export type { Pong } from "./middle";
