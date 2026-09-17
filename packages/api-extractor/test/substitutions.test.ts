import { describe, expect, it } from "vitest";

import type {
  BackendNodeFacts,
  BackendNodeHandle,
  BackendNodeReference,
  BackendSymbolHandle,
  BackendTypeHandle,
  BackendTypeNodeHandle,
} from "../src/backend/contracts.ts";
import type { BindingOperations } from "../src/parse/substitutions.ts";
import { applySubstitutions, bindAliasInstantiation } from "../src/parse/substitutions.ts";

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
  const typeFacts: BindingOperations["typeFacts"] = (type) => {
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

describe("bindAliasInstantiation", () => {
  /** Builds a complete node-fact record so the fake operations need no cast. */
  function factsFor(
    kind: BackendNodeFacts["kind"],
    extra: Omit<Partial<BackendNodeFacts>, "kind">
  ): BackendNodeFacts {
    return { kind, text: "", filePath: "", line: 1, column: 1, ...extra };
  }

  // SAFETY: backend handles are intentionally opaque sentinels here.
  const declaration = {} as BackendNodeReference;
  // SAFETY: backend handles are intentionally opaque sentinels here.
  const instantiation = {} as BackendTypeHandle;
  // SAFETY: backend handles are intentionally opaque sentinels here.
  const sourceNode = {} as BackendNodeReference;
  // SAFETY: backend handles are intentionally opaque sentinels here.
  const parameterA = {} as BackendNodeHandle;
  // SAFETY: backend handles are intentionally opaque sentinels here.
  const parameterB = {} as BackendNodeHandle;
  // SAFETY: backend handles are intentionally opaque sentinels here.
  const parameterC = {} as BackendNodeHandle;
  // SAFETY: backend handles are intentionally opaque sentinels here.
  const symbolA = {} as BackendSymbolHandle;
  // SAFETY: backend handles are intentionally opaque sentinels here.
  const symbolB = {} as BackendSymbolHandle;
  // SAFETY: backend handles are intentionally opaque sentinels here.
  const symbolC = {} as BackendSymbolHandle;
  // SAFETY: backend handles are intentionally opaque sentinels here.
  const authoredA = {} as BackendTypeNodeHandle;
  // SAFETY: backend handles are intentionally opaque sentinels here.
  const authoredHole = {} as BackendTypeNodeHandle;
  // SAFETY: backend handles are intentionally opaque sentinels here.
  const authoredC = {} as BackendTypeNodeHandle;
  // SAFETY: backend handles are intentionally opaque sentinels here.
  const defaultBNode = {} as BackendTypeNodeHandle;
  // SAFETY: backend handles are intentionally opaque sentinels here.
  const argumentA = {} as BackendTypeHandle;
  // SAFETY: backend handles are intentionally opaque sentinels here.
  const argumentC = {} as BackendTypeHandle;
  // SAFETY: backend handles are intentionally opaque sentinels here.
  const defaultB = {} as BackendTypeHandle;

  const nodeFactsByNode = new Map<BackendNodeReference, BackendNodeFacts>([
    [declaration, factsFor("typeAlias", { typeParameters: [parameterA, parameterB, parameterC] })],
    [
      parameterA,
      factsFor("typeParameter", { typeName: { name: "A", namespaces: [], authoredSymbol: symbolA } }),
    ],
    [
      parameterB,
      factsFor("typeParameter", {
        typeName: { name: "B", namespaces: [], authoredSymbol: symbolB },
        defaultType: defaultBNode,
      }),
    ],
    [
      parameterC,
      factsFor("typeParameter", { typeName: { name: "C", namespaces: [], authoredSymbol: symbolC } }),
    ],
    [
      sourceNode,
      factsFor("typeReference", {
        typeName: {
          name: "PartiallyInstantiated",
          namespaces: [],
          authoredArguments: [authoredA, authoredHole, authoredC],
        },
      }),
    ],
  ]);
  const typesByNode = new Map<BackendNodeReference, BackendTypeHandle>([
    [authoredA, argumentA],
    [defaultBNode, defaultB],
    [authoredC, argumentC],
  ]);

  const fakeOperations: BindingOperations = {
    // No semantic alias arguments: the authored reference is the only record.
    typeFacts: () => ({ flags: [] }),
    nodeFacts: (node) => nodeFactsByNode.get(node) ?? factsFor("unknown", {}),
    typeAtNode: (node) => typesByNode.get(node),
  };

  const context = { operations: fakeOperations, substitutions: new Map() };

  it("keeps a hole aligned with its parameter instead of shifting later arguments", () => {
    const bindings = bindAliasInstantiation(declaration, instantiation, sourceNode, context);

    expect(bindings.get(symbolA)).toBe(argumentA);
    // The middle argument has no resolved type, so its parameter keeps the
    // authored default and the third argument stays on the third parameter.
    expect(bindings.get(symbolB)).toBe(defaultB);
    expect(bindings.get(symbolC)).toBe(argumentC);
  });
});
