import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { HandleRegistry } from "../src/backend/handles.ts";

const sourceRoot = resolve(import.meta.dirname, "../src");

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/**
 * The fact cache stops its deep freeze at an already frozen record. That is
 * only sound while every frozen object in `src/**` is frozen all the way
 * down, which holds because just two places freeze anything: the cache
 * itself, which freezes a whole subgraph, and the handle registry, whose
 * handles carry primitives and the session symbol.
 */
describe("the fact cache's frozen short-circuit", () => {
  it("has no freeze site in src/** that could leave an unfrozen child", () => {
    const freezing = sourceFiles(sourceRoot)
      .filter((path) => readFileSync(path, "utf8").includes("Object.freeze("))
      .map((path) => relative(sourceRoot, path))
      .sort();

    expect(freezing).toEqual(["backend/handles.ts", "backend/ts7/session-fact-cache.ts"]);
  });

  it("freezes registry handles over primitives only, so stopping at one loses nothing", () => {
    const registry = new HandleRegistry();
    const handle = registry.create("symbol", { compilerValue: "not reachable from the handle" });

    expect(Object.isFrozen(handle)).toBe(true);
    // Only a member that is itself an object could hide an unfrozen subgraph
    // behind the frozen handle, and a handle carries none.
    expect(Object.values(handle).filter((value) => Object(value) === value)).toEqual([]);
  });
});
