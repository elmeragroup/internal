import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { BackendSymbolHandle, BackendTypeNodeHandle } from "../src/backend/contracts.ts";
import { HandleRegistry } from "../src/backend/handles.ts";
import { openTsgoProject } from "../src/backend/ts7/project.ts";

const fixtureDirectory = resolve(import.meta.dirname, "fixtures/basic");
const tsconfigPath = resolve(fixtureDirectory, "tsconfig.json");
const inputPath = resolve(fixtureDirectory, "input.ts");

const context = {
  operation: "test.handle",
  filePath: "/virtual/input.ts",
  symbolStack: ["Widget", "property: value"],
};

describe("HandleRegistry", () => {
  it("rejects a missing handle with operation breadcrumbs", () => {
    const registry = new HandleRegistry();
    // SAFETY: adversarial handles are opaque test values.
    const missing = {
      kind: "symbol",
      id: 999,
      session: registry.session,
    } as BackendSymbolHandle;

    expect(() => registry.get(missing, "symbol", () => context)).toThrow(
      /Invalid symbol compiler handle in test\.handle/u
    );
    expect(() => registry.get(missing, "symbol", () => context)).toThrow(
      expect.objectContaining({ filePath: context.filePath, symbolStack: context.symbolStack })
    );
  });

  it("rejects handles from a different extraction session", () => {
    const first = new HandleRegistry();
    const second = new HandleRegistry();
    const handle = first.create("symbol", { name: "Widget" });

    expect(() => second.get(handle, "symbol", () => context)).toThrow(/Invalid symbol compiler handle/u);
  });

  it("rejects a handle whose runtime kind differs from the operation", () => {
    const registry = new HandleRegistry();
    const symbol = registry.create("symbol", { name: "Widget" });

    const wrongKind = { ...symbol, kind: "type" as const };
    expect(() => registry.get(wrongKind, "type", () => context)).toThrow(/Invalid type compiler handle/u);
  });

  it("keeps TypeNode handles explicitly distinct from generic node handles", () => {
    const registry = new HandleRegistry();
    const typeNode = {};
    const handle = registry.create("type-node", typeNode);

    expect(registry.get<"type-node", object>(handle, "type-node", () => context)).toBe(typeNode);
    const wrongKind = { ...handle, kind: "node" as const };
    expect(() => registry.get(wrongKind, "node", () => context)).toThrow(/Invalid node compiler handle/u);
    // Keep the package-owned type visible to this adversarial test's compile-time seam.
    const typedHandle: BackendTypeNodeHandle = handle;
    expect(typedHandle.kind).toBe("type-node");
  });

  it("rejects every operation after the extraction session is closed", () => {
    const registry = new HandleRegistry();
    const handle = registry.create("symbol", { name: "Widget" });
    registry.clear();

    expect(() => registry.get(handle, "symbol", () => context)).toThrow(
      /after the extraction session closed/u
    );
    expect(() => registry.create("symbol", { name: "Other" })).toThrow(
      /after the extraction session closed/u
    );
  });

  it("rejects a memoized fact reader for a previously read handle after close", () => {
    const project = openTsgoProject({ tsconfigPath });
    try {
      const session = project.openExtraction();
      const symbol = session.readModule(inputPath).exports[0]?.symbol;
      expect(symbol).toBeDefined();
      if (symbol === undefined) return;
      // Read once so the memoized reader holds the facts, then close: a cached
      // answer must not survive the session that produced it.
      expect(session.compiler.symbolFacts(symbol).name.length).toBeGreaterThan(0);
      session.close();

      expect(() => session.compiler.symbolFacts(symbol)).toThrow(
        /Cannot use the TypeScript extraction session after it closed \(symbolFacts\)/u
      );
    } finally {
      project.close();
    }
  });

  it("allocates an isolated registry for every repeated project extraction", () => {
    const project = openTsgoProject({ tsconfigPath });
    const first = project.openExtraction();
    const firstSymbol = first.readModule(inputPath).exports[0]?.symbol;
    expect(firstSymbol).toBeDefined();
    first.close();

    const second = project.openExtraction();
    const secondSymbol = second.readModule(inputPath).exports[0]?.symbol;
    expect(secondSymbol).toBeDefined();
    if (secondSymbol !== undefined) {
      // Warm the memoized reader so the stale handle from the first extraction
      // meets a populated cache: ids restart at 1 in every registry, so an
      // id-keyed cache would answer with this extraction's facts instead of
      // rejecting the foreign handle.
      expect(second.compiler.symbolFacts(secondSymbol).name.length).toBeGreaterThan(0);
    }
    if (firstSymbol !== undefined) {
      expect(firstSymbol.id).toBe(secondSymbol?.id);
      expect(() => second.compiler.symbolFacts(firstSymbol)).toThrow(/Invalid symbol compiler handle/u);
      expect(() => second.compiler.symbolFacts(firstSymbol)).toThrow(
        expect.objectContaining({ cause: "The handle belongs to another extraction session." })
      );
    }
    second.close();
    project.close();
  });
});
