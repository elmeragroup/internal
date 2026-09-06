import { Schema, Effect, Layer } from "effect";
import { isAbsolute, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type {
  BackendCompilerOperations,
  BackendEnumFacts,
  BackendExtractionSession,
  BackendSymbolHandle,
  BackendTypeHandle,
} from "../src/backend/contracts.ts";
import { CompilerBackend } from "../src/backend/service.ts";
import { projectExtractorLayer } from "../src/extractor.ts";
import { ExtractionResultSchema, ProvenanceSchema, ProjectExtractor } from "../src/index.ts";
import type { ExtractionResult, ExtractorOptions, ShouldResolveObjectData } from "../src/index.ts";
import { extractFixture } from "./support/extract.ts";

const fixtureDirectory = resolve(import.meta.dirname, "fixtures/object-api-documentation");
const tsconfigPath = resolve(fixtureDirectory, "tsconfig.json");
const inputPath = resolve(fixtureDirectory, "input.ts");
const reviewFixtureDirectory = resolve(import.meta.dirname, "fixtures/mixed-repo-provenance");
const reviewTsconfigPath = resolve(reviewFixtureDirectory, "tsconfig.json");
const reviewInputPath = resolve(reviewFixtureDirectory, "input.tsx");
const baseUiFixtureDirectory = resolve(import.meta.dirname, "fixtures/base-ui-component");
const baseUiTsconfigPath = resolve(import.meta.dirname, "fixtures/timing-boundary-tsconfig.json");
const baseUiInputPath = resolve(baseUiFixtureDirectory, "input.tsx");

function runReviewExtraction(options?: ExtractorOptions): Promise<ExtractionResult> {
  return extractFixture({ tsconfigPath: reviewTsconfigPath }, reviewInputPath, options);
}

function runBaseUiExtraction(): Promise<ExtractionResult> {
  return extractFixture({ tsconfigPath: baseUiTsconfigPath }, baseUiInputPath);
}

describe("Issue 03 object APIs, documentation, enums, and provenance", () => {
  it("extracts interface members and enum members through extractModule", async () => {
    const result = await extractFixture({ tsconfigPath }, inputPath);
    const options = result.module.exports.find((entry) => entry.name === "Options");
    const mode = result.module.exports.find((entry) => entry.name === "Mode");

    expect(options).toMatchObject({
      name: "Options",
      documentation: {
        description: "Options accepted by the public operation.",
        tags: [
          { name: "deprecated", value: "Use NewOptions instead." },
          { name: "since", value: "1.0" },
        ],
      },
      type: {
        kind: "object",
        properties: [
          {
            name: "label",
            optional: true,
            type: {
              kind: "union",
              types: [
                { kind: "intrinsic", intrinsic: "string" },
                { kind: "intrinsic", intrinsic: "undefined" },
              ],
            },
          },
          {
            name: "nested",
            optional: false,
            type: {
              kind: "object",
              properties: [{ name: "id", optional: false, type: { kind: "intrinsic", intrinsic: "number" } }],
            },
          },
          {
            name: "format",
            optional: false,
            type: {
              kind: "function",
              callSignatures: [
                {
                  parameters: [
                    { name: "value", optional: false, type: { kind: "intrinsic", intrinsic: "string" } },
                  ],
                  returnValueType: { kind: "intrinsic", intrinsic: "string" },
                },
              ],
            },
          },
        ],
      },
    });
    expect(mode).toMatchObject({
      name: "Mode",
      type: {
        kind: "enum",
        typeName: { name: "Mode" },
        members: [
          { name: "Fast", value: "fast", documentation: { description: "Fast operation." } },
          { name: "Slow", value: 2, documentation: { description: "Slow operation." } },
        ],
      },
    });
  });

  it("anchors return-value provenance beneath object-valued functions and methods", async () => {
    const result = await extractFixture({ tsconfigPath }, inputPath);
    const make = result.module.exports.find((entry) => entry.name === "makeReturnShape");
    const methods = result.module.exports.find((entry) => entry.name === "ReturnMethods");

    expect(make?.type).toMatchObject({
      kind: "function",
      callSignatures: [
        {
          returnValueType: {
            kind: "object",
            properties: [{ name: "value", type: { kind: "intrinsic", intrinsic: "string" } }],
          },
        },
      ],
    });
    expect(methods?.type).toMatchObject({
      kind: "object",
      properties: [
        {
          name: "make",
          type: {
            kind: "function",
            callSignatures: [
              {
                returnValueType: {
                  kind: "object",
                  properties: [{ name: "value" }],
                },
              },
            ],
          },
        },
      ],
    });

    expect(result.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["makeReturnShape", "callSignatures", "0", "returnValueType", "properties", "value"],
        }),
        expect.objectContaining({
          path: [
            "ReturnMethods",
            "properties",
            "make",
            "callSignatures",
            "0",
            "returnValueType",
            "properties",
            "value",
          ],
        }),
      ])
    );
    expect(result.provenance).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["makeReturnShape", "callSignatures", "0", "properties", "value"],
        }),
      ])
    );
  });

  it("preserves ordinary destructuring defaults on parameter-object properties", async () => {
    const result = await extractFixture({ tsconfigPath }, inputPath);
    const configure = result.module.exports.find((entry) => entry.name === "configure");
    expect(configure?.type.kind).toBe("function");
    if (configure?.type.kind !== "function") return;

    const parameter = configure.type.callSignatures[0]?.parameters[0];
    expect(parameter).toBeDefined();
    if (parameter === undefined) return;
    expect(result.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["configure", "callSignatures", "0", "parameters", parameter.name, "properties", "enabled"],
          defaultInitializer: "false",
        }),
      ])
    );
  });

  it("keeps stable repository-relative provenance and authored defaults", async () => {
    const result = await extractFixture({ tsconfigPath }, inputPath);
    expect(result.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["Options"],
          declarations: [
            expect.objectContaining({ path: "test/fixtures/object-api-documentation/input.ts" }),
          ],
          synthesized: false,
        }),
        expect.objectContaining({
          path: ["Options", "properties", "label"],
          declarations: [
            expect.objectContaining({ path: "test/fixtures/object-api-documentation/input.ts" }),
          ],
          synthesized: false,
          readonly: true,
        }),
        expect.objectContaining({
          path: ["use", "callSignatures", "0", "parameters", "options"],
          declarations: [
            expect.objectContaining({ path: "test/fixtures/object-api-documentation/input.ts" }),
          ],
          synthesized: false,
          defaultInitializer: "{ nested: { id: 1 }, format: String }",
        }),
      ])
    );
  });

  it("decodes semantic output and provenance as independent schemas", async () => {
    const result = await extractFixture({ tsconfigPath }, inputPath);

    expect(Schema.decodeUnknownSync(ExtractionResultSchema)(result)).toEqual(result);
    expect(Schema.decodeUnknownSync(ProvenanceSchema)(result.provenance)).toEqual(result.provenance);
    expect(() =>
      Schema.decodeUnknownSync(ProvenanceSchema)([
        {
          path: ["Options"],
          declarations: [{ path: "input.ts" }],
          synthesized: "no",
        },
      ])
    ).toThrow();
  });

  it("honors inclusion and object-resolution policies with deterministic callback data", async () => {
    const includeResult = await extractFixture({ tsconfigPath }, inputPath, {
      shouldInclude: ({ name }) => name !== "id",
    });
    const options = includeResult.module.exports.find((entry) => entry.name === "Options");
    expect(options?.type.kind).toBe("object");
    if (options?.type.kind === "object") {
      expect(options.type.properties.find((property) => property.name === "nested")?.type).toMatchObject({
        kind: "object",
        properties: [],
      });
    }

    const resolveCalls: ShouldResolveObjectData[] = [];
    const resolvedResult = await extractFixture({ tsconfigPath }, inputPath, {
      shouldResolveObject: (data) => {
        resolveCalls.push(data);
        return data.name !== "Options";
      },
    });
    const resolvedOptions = resolvedResult.module.exports.find((entry) => entry.name === "Options");
    expect(resolvedOptions?.type).toMatchObject({ kind: "object", properties: [] });
    expect(resolveCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Options", propertyCount: 3, propertyDepth: 0 }),
      ])
    );
  });

  it("runs object resolution before inclusion and applies the default to undefined nested decisions", async () => {
    const events: string[] = [];
    const result = await runReviewExtraction({
      shouldResolveObject: (data) => {
        events.push(`resolve:${data.name}:${data.propertyCount}:${data.propertyDepth}`);
        return undefined;
      },
      shouldInclude: ({ name }) => {
        events.push(`include:${name}`);
        return name !== "excluded";
      },
    });

    const rootResolution = events.findIndex((event) => event.startsWith("resolve:ResolutionOptions:2:0"));
    const rootInclusion = events.findIndex((event) => event === "include:nested");
    expect(rootResolution).toBeGreaterThanOrEqual(0);
    expect(rootInclusion).toBeGreaterThan(rootResolution);
    expect(events).toContain("resolve:Nested:51:1");
    const options = result.module.exports.find((entry) => entry.name === "options");
    expect(options).toMatchObject({
      type: {
        kind: "object",
        properties: [{ name: "nested", type: { kind: "object", properties: [] } }],
      },
    });
  });

  it("counts only public members of wide class aliases before applying default object resolution", async () => {
    const resolveCalls: ShouldResolveObjectData[] = [];
    const result = await runReviewExtraction({
      shouldResolveObject: (data) => {
        if (data.name === "ThatClass" || data.name === "PublicDerived") resolveCalls.push(data);
        return undefined;
      },
    });

    expect(resolveCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "ThatClass", propertyCount: 1 }),
        expect.objectContaining({ name: "PublicDerived", propertyCount: 2 }),
      ])
    );

    const direct = result.module.exports.find((entry) => entry.name === "DirectAlias");
    const derived = result.module.exports.find((entry) => entry.name === "DerivedAlias");
    expect(direct?.type).toMatchObject({
      kind: "object",
      properties: [{ name: "open" }],
    });
    expect(derived?.type).toMatchObject({
      kind: "object",
      properties: [{ name: "open" }, { name: "own" }],
    });
  });

  it("maps component props and destructuring defaults onto final semantic provenance paths", async () => {
    const result = await runReviewExtraction();
    const button = result.module.exports.find((entry) => entry.name === "Button");
    const directButton = result.module.exports.find((entry) => entry.name === "DirectButton");
    expect(button?.type).toMatchObject({
      kind: "component",
      props: [{ name: "isPending", optional: true }],
    });
    expect(directButton?.type).toMatchObject({
      kind: "component",
      props: [{ name: "isPending", optional: true }],
    });
    expect(result.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["Button", "props", "isPending"],
          defaultInitializer: "false",
        }),
        expect.objectContaining({
          path: ["DirectButton", "props", "isPending"],
          defaultInitializer: "false",
        }),
      ])
    );
    const paths = result.provenance.map((entry) => JSON.stringify(entry.path));
    expect(new Set(paths).size).toBe(paths.length);
    expect(result.provenance.some((entry) => entry.path.includes("callSignatures"))).toBe(false);
    expect(
      result.provenance.some((entry) => entry.path[0] === "Button" && entry.path[1] === "parameter: __0")
    ).toBe(false);
    expect(result.provenance.some((entry) => entry.path.join(".").includes("kind"))).toBe(false);
  });

  it("keeps declaration provenance case-preserving and rooted at an explicit repository cwd", async () => {
    const mixedRoot = resolve(reviewFixtureDirectory, "MixedRepo");
    const result = await extractFixture(
      { tsconfigPath: resolve(mixedRoot, "tsconfig.json"), cwd: mixedRoot },
      resolve(mixedRoot, "packages/UI/src/Widget.ts")
    );
    expect(result.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          declarations: [expect.objectContaining({ path: "packages/UI/src/Widget.ts" })],
        }),
      ])
    );
    expect(result.provenance).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          declarations: [expect.objectContaining({ path: "packages/ui/src/widget.ts" })],
        }),
      ])
    );
    expect(
      result.provenance.every((entry) =>
        entry.declarations.map((declaration) => declaration.path).every((path) => !isAbsolute(path))
      )
    ).toBe(true);
  });

  it("uses the resolved default cwd for nested-tsconfig provenance roots", async () => {
    const mixedRoot = resolve(reviewFixtureDirectory, "MixedRepo");
    const result = await extractFixture(
      { tsconfigPath: resolve(mixedRoot, "tsconfig.json") },
      resolve(mixedRoot, "packages/UI/src/Widget.ts")
    );
    expect(result.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          declarations: [
            expect.objectContaining({
              path: "test/fixtures/mixed-repo-provenance/MixedRepo/packages/UI/src/Widget.ts",
            }),
          ],
        }),
      ])
    );
    expect(result.provenance).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          declarations: [expect.objectContaining({ path: "packages/ui/src/widget.ts" })],
        }),
      ])
    );
  });

  it("keeps every Base UI provenance entry on the final component tree", async () => {
    const result = await runBaseUiExtraction();
    const paths = result.provenance.map((entry) => JSON.stringify(entry.path));
    expect(new Set(paths).size).toBe(paths.length);
    expect(
      result.provenance.some((entry) => entry.path.some((segment) => segment.startsWith("parameter: ")))
    ).toBe(false);
    expect(result.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["BaseUIComponent1", "props", "render"] }),
        expect.objectContaining({
          path: ["BaseUIComponent1", "props", "render", "callSignatures", "0", "parameters", "props"],
        }),
      ])
    );
  });
});

const fakeTsconfigPath = resolve(import.meta.dirname, "fixtures/object-api-documentation/tsconfig.json");
const fakeInputPath = resolve(import.meta.dirname, "fixtures/object-api-documentation/input.ts");

// SAFETY: fake backend identities are opaque seam sentinels.
const synthesizedSymbol = {} as BackendSymbolHandle;
// SAFETY: fake backend identities are opaque seam sentinels.
const generatedSymbol = {} as BackendSymbolHandle;
// SAFETY: fake backend identities are opaque seam sentinels.
const synthesizedType = {} as BackendTypeHandle;
// SAFETY: fake backend identities are opaque seam sentinels.
const generatedType = {} as BackendTypeHandle;
// SAFETY: fake backend identities are opaque seam sentinels.
const missingEnumSymbol = {} as BackendSymbolHandle;
// SAFETY: fake backend identities are opaque seam sentinels.
const missingEnumType = {} as BackendTypeHandle;

function synthesizedCompiler(): BackendCompilerOperations {
  return {
    setErrorContext: () => undefined,
    documentationOfSymbol: () => undefined,
    enumFacts: () => undefined,
    constructSignaturesOfType: () => [],
    documentationOfNode: () => undefined,
    documentationOfParameter: () => undefined,
    typeOfSymbol: (symbol) => (symbol === synthesizedSymbol ? synthesizedType : undefined),
    typeAtNode: () => undefined,
    typeFacts: (type) =>
      type === synthesizedType
        ? { flags: ["Object"], isObject: true, symbol: synthesizedSymbol }
        : { flags: ["Number"], intrinsic: "number" },
    symbolFacts: (symbol) =>
      symbol === synthesizedSymbol
        ? { name: "Synthesized", flags: [], declarationPaths: [], declarations: [] }
        : { name: "generated", flags: [], declarationPaths: [], declarations: [] },
    symbolOrigin: (symbol) => ({
      identity: {
        name: symbol === synthesizedSymbol ? "Synthesized" : "generated",
        namespaces: [],
      },
    }),
    declaringParentIsClass: () => false,
    nodeFacts: () => ({ kind: "unknown", text: "", filePath: fakeInputPath, line: 1, column: 1 }),
    nodeKind: () => "unknown",
    typeNameFacts: (type) => (type === synthesizedType ? { name: "Synthesized", namespaces: [] } : undefined),
    signaturesOfType: () => [],
    signatureFacts: () => ({ parameters: [], typeParameters: [] }),
    declarationOwnership: () => ({ kind: "project" }),
    propertiesOfType: (type) => (type === synthesizedType ? [generatedSymbol] : []),
    propertyType: (symbol) => (symbol === generatedSymbol ? generatedType : undefined),
    indexSignaturesOfType: () => [],
    baseConstraintOfType: () => undefined,
    isArrayType: () => false,
    isReadonlyType: () => false,
    typeToString: () => "number",
  };
}

function synthesizedSession(): BackendExtractionSession {
  return {
    compiler: synthesizedCompiler(),
    readModule: () => ({ name: "input", exports: [{ name: "Synthesized", symbol: synthesizedSymbol }] }),
    resolveModule: () => undefined,
    close: () => undefined,
  };
}

describe("synthesized properties and missing enums through a replacement backend", () => {
  it("returns declarationless synthesized properties through the public extraction seam", async () => {
    const session = synthesizedSession();
    const backendLayer = Layer.succeed(CompilerBackend, {
      openProject: () =>
        Effect.succeed({
          openExtraction: () => session,
          close: () => undefined,
        }),
    });
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const extractor = yield* ProjectExtractor;
          return yield* extractor.extractModule(fakeInputPath);
        }).pipe(
          Effect.provide(
            projectExtractorLayer({ tsconfigPath: fakeTsconfigPath }).pipe(Layer.provide(backendLayer))
          )
        )
      )
    );

    expect(result.module.exports[0]?.type).toMatchObject({
      kind: "object",
      properties: [{ name: "generated", type: { kind: "intrinsic", intrinsic: "number" } }],
    });
    expect(result.provenance).toEqual([
      { path: ["Synthesized"], declarations: [], synthesized: true },
      { path: ["Synthesized", "properties", "generated"], declarations: [], synthesized: true },
    ]);
    expect(Schema.decodeUnknownSync(ExtractionResultSchema)(result)).toEqual(result);
  });

  it("emits shared enum warnings at each occurrence with its own breadcrumb", async () => {
    const warning = Object.freeze({
      code: "missing-enum-declaration" as const,
      filePath: fakeInputPath,
      line: 7,
      column: 3,
      parsedSymbolStack: Object.freeze([]),
      enumName: "SharedMode",
      memberName: "Unknown",
    });
    const facts: BackendEnumFacts = Object.freeze({
      name: "SharedMode",
      namespaces: Object.freeze([]),
      members: Object.freeze([]),
      warnings: Object.freeze([warning]),
    });
    const compiler: BackendCompilerOperations = {
      ...synthesizedCompiler(),
      typeOfSymbol: () => missingEnumType,
      typeFacts: () => ({ flags: ["Enum"], isEnum: true, symbol: missingEnumSymbol }),
      symbolFacts: () => ({ name: "SharedMode", flags: [], declarationPaths: [], declarations: [] }),
      typeNameFacts: () => ({ name: "SharedMode", namespaces: [] }),
      enumFacts: () => facts,
    };
    const session: BackendExtractionSession = {
      compiler,
      readModule: () => ({
        name: "input",
        exports: [
          { name: "First", symbol: missingEnumSymbol },
          { name: "Second", symbol: missingEnumSymbol },
        ],
      }),
      resolveModule: () => undefined,
      close: () => undefined,
    };
    const backend = Layer.succeed(CompilerBackend, {
      openProject: () => Effect.succeed({ openExtraction: () => session, close: () => undefined }),
    });
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const extractor = yield* ProjectExtractor;
          return yield* extractor.extractModule(fakeInputPath);
        }).pipe(
          Effect.provide(
            projectExtractorLayer({ tsconfigPath: fakeTsconfigPath }).pipe(Layer.provide(backend))
          )
        )
      )
    );

    expect(result.warnings).toEqual([
      expect.objectContaining({ ...warning, parsedSymbolStack: [fakeInputPath, "First"] }),
      expect.objectContaining({ ...warning, parsedSymbolStack: [fakeInputPath, "Second"] }),
    ]);
    expect(facts.warnings).toEqual([warning]);
    expect(warning.parsedSymbolStack).toEqual([]);
    expect(Schema.decodeUnknownSync(ExtractionResultSchema)(result)).toEqual(result);
  });

  it("returns missing enum declarations as independently decodable structured warnings", async () => {
    const compiler: BackendCompilerOperations = {
      ...synthesizedCompiler(),
      typeOfSymbol: (symbol) => (symbol === missingEnumSymbol ? missingEnumType : undefined),
      typeFacts: (type) =>
        type === missingEnumType
          ? { flags: ["Enum"], isEnum: true, symbol: missingEnumSymbol }
          : { flags: ["Number"], intrinsic: "number" },
      symbolFacts: (symbol) =>
        symbol === missingEnumSymbol
          ? { name: "MissingMode", flags: [], declarationPaths: [], declarations: [] }
          : { name: "value", flags: [], declarationPaths: [], declarations: [] },
      typeNameFacts: (type) =>
        type === missingEnumType ? { name: "MissingMode", namespaces: [] } : undefined,
    };
    const session: BackendExtractionSession = {
      compiler,
      readModule: () => ({ name: "input", exports: [{ name: "MissingMode", symbol: missingEnumSymbol }] }),
      resolveModule: () => undefined,
      close: () => undefined,
    };
    const backendLayer = Layer.succeed(CompilerBackend, {
      openProject: () => Effect.succeed({ openExtraction: () => session, close: () => undefined }),
    });
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const extractor = yield* ProjectExtractor;
          return yield* extractor.extractModule(fakeInputPath);
        }).pipe(
          Effect.provide(
            projectExtractorLayer({ tsconfigPath: fakeTsconfigPath }).pipe(Layer.provide(backendLayer))
          )
        )
      )
    );

    expect(result.module.exports[0]?.type).toMatchObject({
      kind: "enum",
      typeName: { name: "MissingMode" },
      members: [],
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "missing-enum-declaration",
        enumName: "MissingMode",
        parsedSymbolStack: [fakeInputPath, "MissingMode"],
      }),
    ]);
    expect(Schema.decodeUnknownSync(ExtractionResultSchema)(result)).toEqual(result);
  });
});
