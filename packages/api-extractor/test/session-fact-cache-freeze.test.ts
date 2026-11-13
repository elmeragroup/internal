import { describe, expect, it } from "vitest";

import { HandleRegistry } from "../src/backend/handles.ts";

/**
 * The fact cache stops its deep freeze at an already frozen record. That is
 * only sound while every frozen object in `src/**` is frozen all the way
 * down, which holds because just two places freeze anything: the cache
 * itself, which freezes a whole subgraph, and the handle registry, whose
 * handles carry primitives and the session symbol. `no-restricted-properties`
 * in the root `.oxlintrc.json` holds the freeze sites to those two; this suite
 * checks the registry's half of the argument.
 */
describe("the fact cache's frozen short-circuit", () => {
  it("freezes registry handles over primitives only, so stopping at one loses nothing", () => {
    const registry = new HandleRegistry();
    const handle = registry.create("symbol", { compilerValue: "not reachable from the handle" });

    expect(Object.isFrozen(handle)).toBe(true);
    // Only a member that is itself an object could hide an unfrozen subgraph
    // behind the frozen handle, and a handle carries none.
    expect(Object.values(handle).filter((value) => Object(value) === value)).toEqual([]);
  });
});
