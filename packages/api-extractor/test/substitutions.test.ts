import { describe, expect, it } from "vitest";

import type {
  BackendCompilerOperations,
  BackendSymbolHandle,
  BackendTypeHandle,
} from "../src/backend/contracts.ts";
import { applySubstitutions } from "../src/parse/substitutions.ts";

// Handles are opaque to the parse layer; the helper compares them by identity
// alone, so a distinct empty object is a faithful stand-in for each one.
// SAFETY: backend handles are intentionally opaque sentinels here.
const parameterSymbol = {} as BackendSymbolHandle;
// SAFETY: backend handles are intentionally opaque sentinels here.
const otherSymbol = {} as BackendSymbolHandle;
// SAFETY: backend handles are intentionally opaque sentinels here.
const parameterType = {} as BackendTypeHandle;
// SAFETY: backend handles are intentionally opaque sentinels here.
const argumentType = {} as BackendTypeHandle;
// SAFETY: backend handles are intentionally opaque sentinels here.
const containerType = {} as BackendTypeHandle;
// SAFETY: backend handles are intentionally opaque sentinels here.
const anonymousType = {} as BackendTypeHandle;

const symbolsByType = new Map<BackendTypeHandle, BackendSymbolHandle>([
  [parameterType, parameterSymbol],
  [containerType, otherSymbol],
]);

function operations() {
  let reads = 0;
  const typeFacts: BackendCompilerOperations["typeFacts"] = (type) => {
    reads += 1;
    const symbol = symbolsByType.get(type);
    return symbol === undefined ? { flags: [] } : { flags: [], symbol };
  };
  return { typeFacts, reads: () => reads };
}

describe("applySubstitutions", () => {
  const bindings = new Map([[parameterSymbol, argumentType]]);

  it("rebinds a bare type-parameter reference to its bound argument", () => {
    expect(applySubstitutions(parameterType, bindings, operations())).toBe(argumentType);
  });

  it("keeps a type whose symbol is not bound", () => {
    // A generic container merely mentions the parameter; it still names the
    // uninstantiated type, and the caller pairs it with its instantiation.
    expect(applySubstitutions(containerType, bindings, operations())).toBe(containerType);
  });

  it("keeps a type with no symbol at all", () => {
    expect(applySubstitutions(anonymousType, bindings, operations())).toBe(anonymousType);
  });

  it("passes undefined through", () => {
    expect(applySubstitutions(undefined, bindings, operations())).toBeUndefined();
  });

  it("reads no type facts when no bindings are active", () => {
    const compiler = operations();
    expect(applySubstitutions(parameterType, new Map(), compiler)).toBe(parameterType);
    expect(compiler.reads()).toBe(0);
  });
});
