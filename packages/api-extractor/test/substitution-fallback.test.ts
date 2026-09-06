import { describe, expect, it } from "vitest";

import type {
  BackendCompilerOperations,
  BackendDeclarationOwnership,
  BackendExtractionSession,
  BackendModuleDraft,
  BackendNodeFacts,
  BackendNodeHandle,
  BackendNodeReference,
  BackendSymbolFacts,
  BackendSymbolHandle,
  BackendTypeFacts,
  BackendTypeHandle,
  BackendTypeNameFacts,
  BackendTypeNodeHandle,
  BackendWarningFact,
} from "../src/backend/contracts.ts";
import { resolveModule } from "../src/parse/resolver.ts";

const filePath = "/virtual/input.ts";

const draftWarning: BackendWarningFact = {
  code: "unresolved-re-export",
  filePath,
  line: 2,
  column: 1,
  parsedSymbolStack: [filePath],
  name: "Missing",
  reason: "missing-target",
};

const exportedDraftWarning = {
  ...draftWarning,
  message:
    'Could not resolve re-export "Missing" at "/virtual/input.ts:2:1" because the re-export target could not be resolved. The extractor skipped it. Check the export chain if it must appear in the API.',
};

type TypeRecord = {
  readonly facts: BackendTypeFacts;
  readonly printed?: string;
  readonly name?: BackendTypeNameFacts;
  readonly properties?: readonly BackendSymbolHandle[];
};

type SymbolRecord = {
  readonly facts: BackendSymbolFacts;
  readonly type?: BackendTypeHandle;
  readonly propertyType?: BackendTypeHandle;
};

type CompilerGraph = {
  readonly types: ReadonlyMap<BackendTypeHandle, TypeRecord>;
  readonly symbols: ReadonlyMap<BackendSymbolHandle, SymbolRecord>;
  readonly nodes: ReadonlyMap<BackendNodeReference, BackendNodeFacts>;
  readonly typeAtNode?: ReadonlyMap<BackendNodeReference, BackendTypeHandle>;
  readonly ownership?: ReadonlyMap<BackendNodeReference, BackendDeclarationOwnership>;
  readonly onTypeFacts?: (type: BackendTypeHandle) => void;
};

function opaqueHandle<T>(label: string): T {
  // SAFETY: backend handles are intentionally opaque sentinels here.
  return { label } as T;
}

function requireRecord<K, V>(table: ReadonlyMap<K, V>, key: K, operation: string): V {
  const record = table.get(key);
  if (record === undefined) throw new Error(`${operation} received an unknown handle`);
  return record;
}

function compiler(graph: CompilerGraph): BackendCompilerOperations {
  const typeAtNode: ReadonlyMap<BackendNodeReference, BackendTypeHandle> = graph.typeAtNode ?? new Map();
  const ownership: ReadonlyMap<BackendNodeReference, BackendDeclarationOwnership> =
    graph.ownership ?? new Map();
  return {
    setErrorContext: () => undefined,
    documentationOfSymbol: () => undefined,
    enumFacts: () => undefined,
    constructSignaturesOfType: () => [],
    documentationOfNode: () => undefined,
    documentationOfParameter: () => undefined,
    typeOfSymbol: (symbol) => requireRecord(graph.symbols, symbol, "typeOfSymbol").type,
    typeAtNode: (node) => typeAtNode.get(node),
    typeFacts: (type) => {
      graph.onTypeFacts?.(type);
      return requireRecord(graph.types, type, "typeFacts").facts;
    },
    symbolFacts: (symbol) => requireRecord(graph.symbols, symbol, "symbolFacts").facts,
    symbolOrigin: (symbol) => ({
      identity: {
        name: requireRecord(graph.symbols, symbol, "symbolOrigin").facts.name,
        namespaces: [],
      },
    }),
    declaringParentIsClass: () => false,
    nodeFacts: (node) => requireRecord(graph.nodes, node, "nodeFacts"),
    nodeKind: (node) => requireRecord(graph.nodes, node, "nodeKind").kind,
    typeNameFacts: (type) => requireRecord(graph.types, type, "typeNameFacts").name,
    signaturesOfType: (type) => {
      requireRecord(graph.types, type, "signaturesOfType");
      return [];
    },
    signatureFacts: () => {
      throw new Error("signatureFacts is not used by these substitution probes");
    },
    declarationOwnership: (node) => ownership.get(node) ?? { kind: "project" },
    propertiesOfType: (type) => requireRecord(graph.types, type, "propertiesOfType").properties ?? [],
    propertyType: (property) => {
      const record = requireRecord(graph.symbols, property, "propertyType");
      if (record.propertyType === undefined) {
        throw new Error("propertyType is not defined for this symbol");
      }
      return record.propertyType;
    },
    indexSignaturesOfType: (type) => {
      requireRecord(graph.types, type, "indexSignaturesOfType");
      return [];
    },
    baseConstraintOfType: (type) => {
      requireRecord(graph.types, type, "baseConstraintOfType");
      return undefined;
    },
    isArrayType: (type) => {
      requireRecord(graph.types, type, "isArrayType");
      return false;
    },
    isReadonlyType: (type) => {
      requireRecord(graph.types, type, "isReadonlyType");
      return false;
    },
    typeToString: (type) => {
      const printed = requireRecord(graph.types, type, "typeToString").printed;
      if (printed === undefined) throw new Error("typeToString has no printed form for this handle");
      return printed;
    },
  };
}

function session(operations: BackendCompilerOperations): BackendExtractionSession {
  return {
    compiler: operations,
    readModule: () => {
      throw new Error("readModule is not used by resolveModule");
    },
    resolveModule: () => {
      throw new Error("session.resolveModule is not used by the semantic resolver");
    },
    close: () => undefined,
  };
}

function resolveGraph(graph: CompilerGraph, draft: BackendModuleDraft) {
  return resolveModule(session(compiler(graph)), draft, filePath);
}

function symbolFacts(
  name: string,
  declaration: BackendNodeHandle,
  declarationPath: string
): BackendSymbolFacts {
  return {
    name,
    flags: [],
    declarationPaths: [declarationPath],
    repositoryRelativeDeclarationPaths: [declarationPath],
    declarations: [declaration],
    valueDeclaration: declaration,
  };
}

function nodeFacts(
  kind: BackendNodeFacts["kind"],
  path: string,
  extra?: Omit<BackendNodeFacts, "kind" | "text" | "filePath" | "line" | "column"> & {
    readonly text?: string;
    readonly line?: number;
    readonly column?: number;
  }
): BackendNodeFacts {
  return {
    kind,
    text: extra?.text ?? kind,
    filePath: path,
    line: extra?.line ?? 1,
    column: extra?.column ?? 1,
    ...extra,
  };
}

function exportDeclarationFacts(sourceType: BackendTypeNodeHandle | undefined): BackendNodeFacts {
  const facts = nodeFacts("variable", filePath, {
    text: "value",
    line: 1,
    column: 14,
  });
  if (sourceType !== undefined) Object.assign(facts, { type: sourceType });
  return facts;
}

function stringTypeRecord(): TypeRecord {
  return {
    facts: { flags: ["String"], intrinsic: "string" },
    printed: "string",
  };
}

function errorTypeRecord(printed: string): TypeRecord {
  return {
    facts: { flags: ["Object"], isError: true },
    printed,
  };
}

function namedObjectType(
  symbol: BackendSymbolHandle,
  typeName: string,
  properties: readonly BackendSymbolHandle[]
): TypeRecord {
  return {
    facts: { flags: ["Object"], isObject: true, symbol },
    name: { name: typeName, namespaces: [] },
    properties,
  };
}

function moduleDraft(
  symbol: BackendSymbolHandle,
  name = "value",
  warnings?: readonly BackendWarningFact[]
): BackendModuleDraft {
  const draft: BackendModuleDraft = {
    name: "input",
    exports: [{ name, symbol }],
  };
  if (warnings !== undefined) Object.assign(draft, { warnings });
  return draft;
}

function stringFallbackHandles() {
  return {
    exportSymbol: opaqueHandle<BackendSymbolHandle>("export-symbol"),
    exportDeclaration: opaqueHandle<BackendNodeHandle>("export-declaration"),
    substitutionType: opaqueHandle<BackendTypeHandle>("substitution"),
    errorType: opaqueHandle<BackendTypeHandle>("error"),
    stringType: opaqueHandle<BackendTypeHandle>("string"),
  };
}

function stringFallbackGraph(
  handles = stringFallbackHandles(),
  extra?: {
    readonly sourceType?: BackendTypeNodeHandle;
    readonly onTypeFacts?: (type: BackendTypeHandle) => void;
    readonly substitution?: TypeRecord;
    readonly extraTypes?: readonly (readonly [BackendTypeHandle, TypeRecord])[];
    readonly extraNodes?: readonly (readonly [BackendNodeReference, BackendNodeFacts])[];
  }
) {
  const { exportSymbol, exportDeclaration, substitutionType, errorType, stringType } = handles;
  return {
    handles,
    graph: {
      types: new Map<BackendTypeHandle, TypeRecord>([
        [
          substitutionType,
          extra?.substitution ?? {
            facts: {
              flags: ["Substitution"],
              substitutionBaseType: errorType,
              substitutionConstraint: stringType,
            },
            printed: "T extends string ? T : string",
          },
        ],
        [errorType, errorTypeRecord("Broken")],
        [stringType, stringTypeRecord()],
        ...(extra?.extraTypes ?? []),
      ]),
      symbols: new Map<BackendSymbolHandle, SymbolRecord>([
        [
          exportSymbol,
          {
            facts: symbolFacts("value", exportDeclaration, filePath),
            type: substitutionType,
          },
        ],
      ]),
      nodes: new Map<BackendNodeReference, BackendNodeFacts>([
        [exportDeclaration, exportDeclarationFacts(extra?.sourceType)],
        ...(extra?.extraNodes ?? []),
      ]),
      onTypeFacts: extra?.onTypeFacts,
    } satisfies CompilerGraph,
  };
}

describe("substitution fallback evidence isolation", () => {
  it("returns the constraint model without the rejected base-type warning", () => {
    const { handles, graph } = stringFallbackGraph();
    const result = resolveGraph(graph, moduleDraft(handles.exportSymbol));

    expect(result.module.exports[0]?.type).toEqual({ kind: "intrinsic", intrinsic: "string" });
    expect(result.warnings).toEqual([]);
  });

  it("preserves unrelated draft warnings when a rejected probe would have warned", () => {
    const { handles, graph } = stringFallbackGraph();
    const result = resolveGraph(graph, moduleDraft(handles.exportSymbol, "value", [draftWarning]));

    expect(result.module.exports[0]?.type).toEqual({ kind: "intrinsic", intrinsic: "string" });
    expect(result.warnings).toEqual([exportedDraftWarning]);
  });
});

describe("substitution fallback provenance isolation", () => {
  it("discards rejected property provenance at the same semantic path the accepted candidate keeps", () => {
    const exportSymbol = opaqueHandle<BackendSymbolHandle>("export-symbol");
    const exportDeclaration = opaqueHandle<BackendNodeHandle>("export-declaration");
    const substitutionType = opaqueHandle<BackendTypeHandle>("substitution");
    const rejectedObjectType = opaqueHandle<BackendTypeHandle>("rejected-object");
    const acceptedObjectType = opaqueHandle<BackendTypeHandle>("accepted-object");
    const unsupportedNestedType = opaqueHandle<BackendTypeHandle>("unsupported-nested");
    const stringType = opaqueHandle<BackendTypeHandle>("string");
    const rejectedObjectSymbol = opaqueHandle<BackendSymbolHandle>("rejected-object-symbol");
    const acceptedObjectSymbol = opaqueHandle<BackendSymbolHandle>("accepted-object-symbol");
    const rejectedIdProperty = opaqueHandle<BackendSymbolHandle>("rejected-id");
    const acceptedIdProperty = opaqueHandle<BackendSymbolHandle>("accepted-id");
    const rejectedObjectDeclaration = opaqueHandle<BackendNodeHandle>("rejected-object-declaration");
    const acceptedObjectDeclaration = opaqueHandle<BackendNodeHandle>("accepted-object-declaration");
    const rejectedIdDeclaration = opaqueHandle<BackendNodeHandle>("rejected-id-declaration");
    const acceptedIdDeclaration = opaqueHandle<BackendNodeHandle>("accepted-id-declaration");
    const observedTypes: BackendTypeHandle[] = [];

    const result = resolveGraph(
      {
        types: new Map([
          [
            substitutionType,
            {
              facts: {
                flags: ["Substitution"],
                substitutionBaseType: rejectedObjectType,
                substitutionConstraint: acceptedObjectType,
              },
              printed: "Substitute",
            },
          ],
          [rejectedObjectType, namedObjectType(rejectedObjectSymbol, "Rejected", [rejectedIdProperty])],
          [acceptedObjectType, namedObjectType(acceptedObjectSymbol, "Accepted", [acceptedIdProperty])],
          [
            unsupportedNestedType,
            {
              facts: { flags: ["Other"] },
              printed: "UnsupportedNested",
            },
          ],
          [stringType, stringTypeRecord()],
        ]),
        symbols: new Map([
          [
            exportSymbol,
            {
              facts: symbolFacts("value", exportDeclaration, filePath),
              type: substitutionType,
            },
          ],
          [
            rejectedObjectSymbol,
            { facts: symbolFacts("Rejected", rejectedObjectDeclaration, "rejected-shape.ts") },
          ],
          [
            acceptedObjectSymbol,
            { facts: symbolFacts("Accepted", acceptedObjectDeclaration, "accepted-shape.ts") },
          ],
          [
            rejectedIdProperty,
            {
              facts: symbolFacts("id", rejectedIdDeclaration, "discarded.ts"),
              propertyType: unsupportedNestedType,
            },
          ],
          [
            acceptedIdProperty,
            {
              facts: symbolFacts("id", acceptedIdDeclaration, "accepted.ts"),
              propertyType: stringType,
            },
          ],
        ]),
        nodes: new Map<BackendNodeReference, BackendNodeFacts>([
          [exportDeclaration, nodeFacts("variable", filePath, { text: "value", column: 14 })],
          [rejectedObjectDeclaration, nodeFacts("interface", "rejected-shape.ts", { text: "Rejected" })],
          [acceptedObjectDeclaration, nodeFacts("interface", "accepted-shape.ts", { text: "Accepted" })],
          [
            rejectedIdDeclaration,
            nodeFacts("property", "discarded.ts", {
              text: "id",
              line: 4,
              column: 3,
              declarationFlags: ["readonly"],
              initializerText: '"discarded"',
            }),
          ],
          [
            acceptedIdDeclaration,
            nodeFacts("property", "accepted.ts", {
              text: "id",
              line: 2,
              column: 3,
              initializerText: '"kept"',
            }),
          ],
        ]),
        onTypeFacts: (type) => observedTypes.push(type),
      },
      moduleDraft(exportSymbol)
    );

    expect(observedTypes).toContain(unsupportedNestedType);
    expect(result.module.exports[0]?.type).toEqual({
      kind: "object",
      typeName: { name: "Accepted" },
      properties: [{ name: "id", optional: false, type: { kind: "intrinsic", intrinsic: "string" } }],
    });
    expect(result.warnings).toEqual([]);
    expect(result.provenance).toEqual([
      {
        path: ["value"],
        declarations: [{ path: filePath, owner: { kind: "project" } }],
        synthesized: false,
      },
      {
        path: ["value", "properties", "id"],
        declarations: [{ path: "accepted.ts", owner: { kind: "project" } }],
        synthesized: false,
        defaultInitializer: '"kept"',
      },
    ]);
    expect(JSON.stringify(result.provenance)).not.toContain("discarded.ts");
    expect(result.provenance.some((entry) => entry.readonly === true)).toBe(false);
    expect(result.provenance.some((entry) => entry.defaultInitializer === '"discarded"')).toBe(false);
  });
});

describe("substitution fallback keyof reconstruction", () => {
  it("keeps the authored operator and does not commit rejected probe provenance", () => {
    const exportSymbol = opaqueHandle<BackendSymbolHandle>("keys-symbol");
    const exportDeclaration = opaqueHandle<BackendNodeHandle>("keys-declaration");
    const keyofNode = opaqueHandle<BackendTypeNodeHandle>("keyof-node");
    const operandNode = opaqueHandle<BackendTypeNodeHandle>("operand-node");
    const substitutionType = opaqueHandle<BackendTypeHandle>("substitution");
    const probeObjectType = opaqueHandle<BackendTypeHandle>("probe-object");
    const operandType = opaqueHandle<BackendTypeHandle>("operand-object");
    const keyLiteralType = opaqueHandle<BackendTypeHandle>("key-literal");
    const stringType = opaqueHandle<BackendTypeHandle>("string");
    const probeObjectSymbol = opaqueHandle<BackendSymbolHandle>("probe-object-symbol");
    const probeIdProperty = opaqueHandle<BackendSymbolHandle>("probe-id");
    const operandIdProperty = opaqueHandle<BackendSymbolHandle>("operand-id");
    const probeObjectDeclaration = opaqueHandle<BackendNodeHandle>("probe-object-declaration");
    const probeIdDeclaration = opaqueHandle<BackendNodeHandle>("probe-id-declaration");
    const operandIdDeclaration = opaqueHandle<BackendNodeHandle>("operand-id-declaration");

    const result = resolveGraph(
      {
        types: new Map([
          [
            substitutionType,
            {
              facts: {
                flags: ["Substitution"],
                isUnion: true,
                unionOrIntersectionTypes: [keyLiteralType],
                substitutionBaseType: probeObjectType,
              },
              printed: "T extends object ? T : never",
            },
          ],
          [probeObjectType, namedObjectType(probeObjectSymbol, "Probe", [probeIdProperty])],
          [
            operandType,
            {
              facts: { flags: ["Object"], isObject: true },
              properties: [operandIdProperty],
            },
          ],
          [
            keyLiteralType,
            {
              facts: { flags: ["StringLiteral"], literal: "id" },
              printed: '"id"',
            },
          ],
          [stringType, stringTypeRecord()],
        ]),
        symbols: new Map([
          [
            exportSymbol,
            {
              facts: symbolFacts("Keys", exportDeclaration, filePath),
              type: substitutionType,
            },
          ],
          [probeObjectSymbol, { facts: symbolFacts("Probe", probeObjectDeclaration, "probe-rejected.ts") }],
          [
            probeIdProperty,
            {
              facts: symbolFacts("id", probeIdDeclaration, "probe-rejected.ts"),
              propertyType: stringType,
            },
          ],
          [
            operandIdProperty,
            {
              facts: symbolFacts("id", operandIdDeclaration, "operand.ts"),
              propertyType: stringType,
            },
          ],
        ]),
        nodes: new Map<BackendNodeReference, BackendNodeFacts>([
          [
            exportDeclaration,
            nodeFacts("typeAlias", filePath, {
              text: "type Keys = keyof { id: string }",
              type: keyofNode,
            }),
          ],
          [
            keyofNode,
            nodeFacts("typeOperator", filePath, {
              text: "keyof { id: string }",
              operator: "keyof",
              children: [operandNode],
              column: 14,
            }),
          ],
          [
            operandNode,
            nodeFacts("unknown", filePath, {
              text: "{ id: string }",
              column: 20,
            }),
          ],
          [probeObjectDeclaration, nodeFacts("interface", "probe-rejected.ts", { text: "Probe" })],
          [
            probeIdDeclaration,
            nodeFacts("property", "probe-rejected.ts", {
              text: "id",
              declarationFlags: ["readonly"],
              initializerText: '"from-probe"',
            }),
          ],
          [operandIdDeclaration, nodeFacts("property", "operand.ts", { text: "id", line: 1, column: 22 })],
        ]),
        typeAtNode: new Map([[operandNode, operandType]]),
      },
      moduleDraft(exportSymbol, "Keys")
    );

    expect(result.warnings).toEqual([]);
    expect(result.module.exports[0]?.type).toEqual({
      kind: "typeOperator",
      operator: "keyof",
      type: {
        kind: "object",
        properties: [{ name: "id", optional: false, type: { kind: "intrinsic", intrinsic: "string" } }],
      },
      resolvedType: { kind: "literal", value: '"id"' },
      resolutionKind: "exact",
    });
    expect(result.provenance).toEqual([
      {
        path: ["Keys"],
        declarations: [{ path: filePath, owner: { kind: "project" } }],
        synthesized: false,
      },
      {
        path: ["Keys", "properties", "id"],
        declarations: [{ path: "operand.ts", owner: { kind: "project" } }],
        synthesized: false,
      },
    ]);
    expect(JSON.stringify(result.provenance)).not.toContain("probe-rejected.ts");
    expect(result.provenance.some((entry) => entry.readonly === true)).toBe(false);
    expect(result.provenance.some((entry) => entry.defaultInitializer === '"from-probe"')).toBe(false);
  });
});

describe("substitution fallback candidate order and exhaustion", () => {
  it("accepts the first successful candidate and does not read the second", () => {
    const handles = stringFallbackHandles();
    const unreadConstraint = opaqueHandle<BackendTypeHandle>("unread-constraint");
    const observedTypes: BackendTypeHandle[] = [];
    const { graph } = stringFallbackGraph(handles, {
      substitution: {
        facts: {
          flags: ["Substitution"],
          substitutionBaseType: handles.stringType,
          substitutionConstraint: unreadConstraint,
        },
        printed: "T extends string ? T : never",
      },
      onTypeFacts: (type) => observedTypes.push(type),
    });

    const result = resolveGraph(graph, moduleDraft(handles.exportSymbol));

    expect(result.module.exports[0]?.type).toEqual({ kind: "intrinsic", intrinsic: "string" });
    expect(result.warnings).toEqual([]);
    expect(observedTypes).toContain(handles.stringType);
    expect(observedTypes).not.toContain(unreadConstraint);
  });

  it("falls through to the constraint when the substitution has no base type", () => {
    const handles = stringFallbackHandles();
    const { graph } = stringFallbackGraph(handles, {
      substitution: {
        facts: {
          flags: ["Substitution"],
          substitutionConstraint: handles.stringType,
        },
        printed: "T extends string ? T : never",
      },
    });

    const result = resolveGraph(graph, moduleDraft(handles.exportSymbol));

    expect(result.module.exports[0]?.type).toEqual({ kind: "intrinsic", intrinsic: "string" });
    expect(result.warnings).toEqual([]);
  });

  it("rejects a silent unauthored any and keeps the next candidate", () => {
    const handles = stringFallbackHandles();
    const indexedAccessType = opaqueHandle<BackendTypeHandle>("indexed-access");
    const { graph } = stringFallbackGraph(handles, {
      substitution: {
        facts: {
          flags: ["Substitution"],
          substitutionBaseType: indexedAccessType,
          substitutionConstraint: handles.stringType,
        },
        printed: "T[K]",
      },
      extraTypes: [
        [
          indexedAccessType,
          {
            facts: { flags: ["IndexedAccess"] },
            printed: "T[K]",
          },
        ],
      ],
    });

    const result = resolveGraph(graph, moduleDraft(handles.exportSymbol));

    expect(result.module.exports[0]?.type).toEqual({ kind: "intrinsic", intrinsic: "string" });
    expect(result.warnings).toEqual([]);
  });

  it("reports only the original fallback when every probe fails and no shape remains", () => {
    const handles = stringFallbackHandles();
    const constraintError = opaqueHandle<BackendTypeHandle>("constraint-error");
    const sourceType = opaqueHandle<BackendTypeNodeHandle>("source-type");
    const { graph } = stringFallbackGraph(handles, {
      sourceType,
      substitution: {
        facts: {
          flags: ["Substitution"],
          substitutionBaseType: handles.errorType,
          substitutionConstraint: constraintError,
        },
        printed: "OriginalSubstitution",
      },
      extraTypes: [[constraintError, errorTypeRecord("BrokenConstraint")]],
      extraNodes: [
        [
          sourceType,
          nodeFacts("type", filePath, {
            text: "Substitute",
            line: 3,
            column: 8,
          }),
        ],
      ],
    });

    const result = resolveGraph(graph, moduleDraft(handles.exportSymbol));

    expect(result.module.exports[0]?.type).toEqual({ kind: "intrinsic", intrinsic: "any" });
    expect(result.warnings).toEqual([
      {
        code: "unsupported-type-fallback",
        filePath,
        line: 3,
        column: 8,
        parsedSymbolStack: [filePath, "value"],
        typeFlags: ["Substitution"],
        typeText: "OriginalSubstitution",
        sourceText: "Substitute",
        message:
          'Could not extract type "OriginalSubstitution" while resolving "Substitute" at "/virtual/input.ts:3:8". The extractor used any. Review this API or add support for this type.',
      },
    ]);
  });

  it("propagates a backend exception instead of treating it as an unresolved candidate", () => {
    const handles = stringFallbackHandles();
    const explodingType = opaqueHandle<BackendTypeHandle>("exploding");
    const { graph } = stringFallbackGraph(handles, {
      substitution: {
        facts: {
          flags: ["Substitution"],
          substitutionBaseType: explodingType,
          substitutionConstraint: handles.stringType,
        },
        printed: "T extends string ? T : never",
      },
      extraTypes: [
        [
          explodingType,
          {
            facts: { flags: ["Object"] },
            printed: "explode",
          },
        ],
      ],
      onTypeFacts: (type) => {
        if (type === explodingType) throw new Error("checker operation failed");
      },
    });

    expect(() => resolveGraph(graph, moduleDraft(handles.exportSymbol))).toThrow("checker operation failed");
  });
});
