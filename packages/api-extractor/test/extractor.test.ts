import { Cause, Effect, Layer, Option, Schema } from "effect";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type {
  BackendCompilerOperations,
  BackendExtractionSession,
  BackendModuleDraft,
  BackendSymbolHandle,
  BackendTypeHandle,
  BackendSignatureHandle,
} from "../src/backend/contracts.ts";
import { CompilerBackend } from "../src/backend/service.ts";
import { safeCause } from "../src/errors.ts";
import { projectExtractorLayer } from "../src/extractor.ts";
import {
  BackendError,
  ConfigError,
  ExtractError,
  FileNotInProgramError,
  ModuleNodeSchema,
  ProjectExtractor,
} from "../src/index.ts";
import type { ExtractionResult } from "../src/index.ts";
import type { ExtractorOptions } from "../src/options.ts";
import { extractFixture } from "./support/extract.ts";

const fixtureDirectory = resolve(import.meta.dirname, "fixtures/basic");
const tsconfigPath = resolve(fixtureDirectory, "tsconfig.json");
const inputPath = resolve(fixtureDirectory, "input.ts");
const unsupportedPath = resolve(fixtureDirectory, "unsupported.ts");
const unsupportedTemplatePath = resolve(fixtureDirectory, "unsupported-template.ts");
const unsupportedSignaturesPath = resolve(fixtureDirectory, "unsupported-signatures.ts");
const missingTsconfigPath = resolve(fixtureDirectory, "missing-tsconfig.json");
const invalidTsconfigPath = resolve(fixtureDirectory, "invalid-tsconfig.json");
const rootDirTsconfigPath = resolve(import.meta.dirname, "fixtures/root-dir/tsconfig.json");
const rootDirInputPath = resolve(import.meta.dirname, "fixtures/root-dir/src/input.ts");

class CompilerFailure extends Error {
  readonly _tag = "CompilerFailure";
  readonly handle = {};
  self?: CompilerFailure;

  constructor() {
    super("checker failed");
    this.name = "CompilerFailure";
  }
}

function runWithBackend(
  backendSession: BackendExtractionSession,
  filePath: string,
  extractorOptions?: ExtractorOptions
): Promise<ExtractionResult> {
  let closed = false;
  const session: BackendExtractionSession = {
    ...backendSession,
    close: () => {
      if (closed) return;
      closed = true;
      backendSession.close();
    },
  };
  const backendLayer = Layer.succeed(CompilerBackend, {
    openProject: () =>
      Effect.succeed({
        openExtraction: () => session,
        close: session.close,
      }),
  });
  const extractorLayer = projectExtractorLayer({ tsconfigPath }).pipe(Layer.provide(backendLayer));
  const program = Effect.scoped(
    Effect.gen(function* () {
      const extractor = yield* ProjectExtractor;
      return yield* extractor.extractModule(filePath, extractorOptions);
    }).pipe(Effect.provide(extractorLayer))
  );
  return Effect.runPromise(program);
}

// SAFETY: fake backend identities are opaque test handles.
const fakeSymbol = {} as BackendSymbolHandle;
// SAFETY: fake backend identities are opaque test handles.
const fakeType = {} as BackendTypeHandle;

function backendModule(): BackendModuleDraft {
  return {
    name: "input",
    exports: [
      {
        name: "greet",
        symbol: fakeSymbol,
      },
    ],
  };
}

const testCompiler: BackendCompilerOperations = {
  setErrorContext: () => undefined,
  documentationOfSymbol: () => undefined,
  enumFacts: () => undefined,
  constructSignaturesOfType: () => [],
  documentationOfNode: () => undefined,
  documentationOfParameter: () => undefined,
  typeOfSymbol: () => undefined,
  typeAtNode: () => undefined,
  typeFacts: () => ({ flags: ["Unknown"], intrinsic: "unknown" }),
  symbolFacts: () => ({ name: "greet", flags: [], declarationPaths: [], declarations: [] }),
  symbolOrigin: () => ({ identity: { name: "greet", namespaces: [] } }),
  declaringParentIsClass: () => false,
  nodeFacts: () => ({ kind: "unknown", text: "", filePath: "", line: 1, column: 1 }),
  nodeKind: () => "unknown",
  typeNameFacts: () => undefined,
  // SAFETY: fake backend identities are opaque test handles.
  signaturesOfType: () => [] as readonly BackendSignatureHandle[],
  signatureFacts: () => ({ parameters: [], returnType: fakeType, typeParameters: [] }),
  declarationOwnership: () => ({ kind: "project" }),
  propertiesOfType: () => [],
  propertyType: () => undefined,
  indexSignaturesOfType: () => [],
  baseConstraintOfType: () => undefined,
  isArrayType: () => false,
  isReadonlyType: () => false,
  typeToString: () => "unknown",
};

describe("ProjectExtractor", () => {
  it("extracts an exported function through the scoped service", async () => {
    const result = await extractFixture({ tsconfigPath }, inputPath);
    const exported = result.module.exports.find((entry) => entry.name === "greet");

    expect(result.module.name).toBe("input");
    expect(exported).toMatchObject({
      name: "greet",
      type: {
        kind: "function",
        typeName: { name: "greet" },
        callSignatures: [
          {
            parameters: [
              {
                name: "name",
                optional: false,
                type: { kind: "intrinsic", intrinsic: "string" },
              },
            ],
            returnValueType: { kind: "intrinsic", intrinsic: "string" },
          },
        ],
      },
      documentation: { description: "Greets one person.", tags: [] },
    });
    expect(result.warnings).toEqual([]);
    expect(result.provenance).toEqual([
      expect.objectContaining({ path: ["greet"], synthesized: false }),
      expect.objectContaining({
        path: ["greet", "callSignatures", "0", "parameters", "name"],
        synthesized: false,
      }),
    ]);
  });

  it("names modules relative to compilerOptions.rootDir rather than the tsconfig directory", async () => {
    const result = await extractFixture({ tsconfigPath: rootDirTsconfigPath }, rootDirInputPath);

    expect(result.module.name).toBe("root-dir/src/input");
  });

  it("returns a typed fatal failure for an input outside the immutable project", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const extractor = yield* ProjectExtractor;
          return yield* extractor.extractModule(resolve(fixtureDirectory, "missing.ts"));
        }).pipe(Effect.provide(ProjectExtractor.live({ tsconfigPath })))
      )
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const error = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(error)).toBe(true);
      if (Option.isSome(error)) {
        expect(error.value).toEqual(expect.objectContaining({ _tag: "FileNotInProgramError" }));
      }
    }
  });

  it("classifies missing and invalid project configuration as ConfigError", async () => {
    for (const configPath of [missingTsconfigPath, invalidTsconfigPath]) {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const extractor = yield* ProjectExtractor;
            return yield* extractor.extractModule(inputPath);
          }).pipe(Effect.provide(ProjectExtractor.live({ tsconfigPath: configPath })))
        )
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(error.value).toBeInstanceOf(ConfigError);
          expect(error.value).toEqual(expect.objectContaining({ tsconfigPath: configPath }));
        }
      }
    }
  });

  it("decodes the kind-discriminated module schema and rejects malformed nodes", async () => {
    const result = await extractFixture({ tsconfigPath }, inputPath);
    const decoded = Schema.decodeUnknownSync(ModuleNodeSchema)(result.module);

    expect(decoded).toEqual(result.module);
    expect(() =>
      Schema.decodeUnknownSync(ModuleNodeSchema)({
        name: "input",
        exports: [
          {
            name: "bad",
            type: {
              kind: "function",
              callSignatures: [
                {
                  parameters: [],
                  returnValueType: { kind: "intrinsic", intrinsic: "not-an-intrinsic" },
                },
              ],
            },
          },
        ],
      })
    ).toThrow();
  });

  it("closes the injected compiler backend when the scoped effect succeeds or fails", async () => {
    let successClosed = 0;
    await runWithBackend(
      {
        compiler: testCompiler,
        readModule: () => backendModule(),
        resolveModule: () => undefined,
        close: () => (successClosed += 1),
      },
      inputPath
    );
    expect(successClosed).toBe(1);

    let failureClosed = 0;
    await expect(
      runWithBackend(
        {
          compiler: testCompiler,
          readModule: () => {
            throw new FileNotInProgramError({
              filePath: inputPath,
              message: "fixture failure",
            });
          },
          resolveModule: () => undefined,
          close: () => (failureClosed += 1),
        },
        inputPath
      )
    ).rejects.toBeInstanceOf(FileNotInProgramError);
    expect(failureClosed).toBe(1);
  });

  it("keeps the public extraction seam backend-neutral", async () => {
    const result = await runWithBackend(
      {
        compiler: testCompiler,
        readModule: () => ({
          name: "input",
          typeOnlyStarExports: ["./source.js"],
          exports: [
            {
              name: "Value",
              symbol: fakeSymbol,
              declarationSourcePath: "/virtual/source.d.ts",
              pureType: true,
            },
            {
              name: "RuntimeValue",
              symbol: fakeSymbol,
              declarationSourcePath: "/virtual/source.d.ts",
            },
          ],
        }),
        resolveModule: () => ({ filePath: "/virtual/source.d.ts", isTypeOnly: true }),
        close: () => undefined,
      },
      inputPath
    );

    expect(result.module.exports.map((entry) => entry.name)).toEqual(["Value"]);
  });

  it("classifies raw compiler operation failures as BackendError", async () => {
    await expect(
      runWithBackend(
        {
          compiler: testCompiler,
          readModule: () => {
            throw new Error("compiler operation failed");
          },
          resolveModule: () => undefined,
          close: () => undefined,
        },
        inputPath
      )
    ).rejects.toMatchObject({
      _tag: "BackendError",
      filePath: inputPath,
      operation: "readModule",
      cause: "Error: compiler operation failed",
    });

    const throwingCompiler: BackendCompilerOperations = {
      ...testCompiler,
      typeOfSymbol: () => fakeType,
      typeFacts: () => {
        throw new Error("checker operation failed");
      },
    };
    await expect(
      runWithBackend(
        {
          compiler: throwingCompiler,
          readModule: () => backendModule(),
          resolveModule: () => undefined,
          close: () => undefined,
        },
        inputPath
      )
    ).rejects.toMatchObject({
      _tag: "BackendError",
      filePath: inputPath,
      operation: "typeFacts",
      symbolStack: ["greet"],
      cause: "Error: checker operation failed",
    });
  });

  it("preserves a fully contextual BackendError without wrapping it again", async () => {
    const existing = new BackendError({
      message: "contextual compiler failure",
      cause: "native read failure",
      operation: "readModule",
      filePath: inputPath,
      symbolStack: ["input", "value"],
    });

    await expect(
      runWithBackend(
        {
          compiler: testCompiler,
          readModule: () => {
            throw existing;
          },
          resolveModule: () => undefined,
          close: () => undefined,
        },
        inputPath
      )
    ).rejects.toBe(existing);
  });

  it("enriches only missing BackendError context", async () => {
    const existing = new BackendError({
      message: "missing operation context",
      cause: "native read failure",
      filePath: inputPath,
      symbolStack: ["input", "value"],
    });

    await expect(
      runWithBackend(
        {
          compiler: testCompiler,
          readModule: () => {
            throw existing;
          },
          resolveModule: () => undefined,
          close: () => undefined,
        },
        inputPath
      )
    ).rejects.toMatchObject({
      _tag: "BackendError",
      operation: "readModule",
      filePath: inputPath,
      symbolStack: ["input", "value"],
    });
  });

  it("classifies raw module-resolution failures as contextual BackendError", async () => {
    await expect(
      runWithBackend(
        {
          compiler: testCompiler,
          readModule: () => ({
            ...backendModule(),
            typeOnlyStarExports: ["./source.js"],
          }),
          resolveModule: (_specifier, containingFile) => {
            throw new Error(`resolution failed for ${containingFile}`);
          },
          close: () => undefined,
        },
        inputPath
      )
    ).rejects.toMatchObject({
      _tag: "BackendError",
      operation: "resolveModule",
      filePath: inputPath,
      cause: `Error: resolution failed for ${inputPath}`,
    });
  });

  it("normalizes cyclic compiler-shaped causes without retaining backend handles", async () => {
    const cyclic = new CompilerFailure();
    cyclic.self = cyclic;
    expect(safeCause(cyclic)).toBe("CompilerFailure: checker failed");

    await expect(
      runWithBackend(
        {
          compiler: testCompiler,
          readModule: () => {
            throw cyclic;
          },
          resolveModule: () => undefined,
          close: () => undefined,
        },
        inputPath
      )
    ).rejects.toMatchObject({
      _tag: "BackendError",
      cause: "CompilerFailure: checker failed",
    });
  });

  it("maps resolver policy callback failures to ExtractError with a symbol breadcrumb", async () => {
    try {
      await extractFixture({ tsconfigPath }, unsupportedPath, {
        shouldInclude: () => {
          throw new Error("user policy failed");
        },
      });
      throw new Error("Expected resolver policy failure");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ExtractError);
      // SAFETY: the `toBeInstanceOf` assertion on the line above established the class.
      const error = cause as ExtractError;
      expect(error.filePath).toBe(unsupportedPath);
      expect(error.symbolStack).toEqual([unsupportedPath, "value"]);
      expect(error.message).toContain("shouldInclude");
    }
  });

  it("returns structured warnings without logging automatically", async () => {
    const consoleMethods = ["debug", "error", "info", "log", "warn"] as const;
    const consoleSpies = consoleMethods.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined)
    );
    try {
      const result = await extractFixture({ tsconfigPath }, unsupportedPath);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toEqual(
        expect.objectContaining({
          code: "unsupported-type-fallback",
          filePath: unsupportedPath,
          line: 1,
          column: 14,
          parsedSymbolStack: [unsupportedPath, "value"],
          typeFlags: ["Object"],
          typeText: "{ answer: number; }",
        })
      );
      expect(result.module.exports[0]).toEqual({
        name: "value",
        type: { kind: "intrinsic", intrinsic: "any" },
      });
      expect(result.warnings[0]?.message).toContain("The extractor used any.");
      expect(result.warnings[0]?.message).toContain("Review this API or add support for this type.");
      for (const consoleSpy of consoleSpies) expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      for (const consoleSpy of consoleSpies) consoleSpy.mockRestore();
    }
  });

  it("renders a template-literal type as a template-literal string, not any", async () => {
    const result = await extractFixture({ tsconfigPath }, unsupportedTemplatePath);

    expect(result.module.exports[0]).toEqual({
      name: "Template",
      type: { kind: "literal", value: "`prefix-${string}`" },
    });
    expect(result.warnings).toEqual([]);
  });

  it("renders template-literal parameter and return types without falling back", async () => {
    const result = await extractFixture({ tsconfigPath }, unsupportedSignaturesPath);

    expect(result.warnings).toEqual([]);
    const parameter = result.module.exports.find((entry) => entry.name === "unsupportedParameter");
    const returned = result.module.exports.find((entry) => entry.name === "unsupportedReturn");
    expect(parameter?.type).toMatchObject({
      kind: "function",
      callSignatures: [
        {
          parameters: [{ name: "value", type: { kind: "literal", value: "`param-${string}`" } }],
        },
      ],
    });
    expect(returned?.type).toMatchObject({
      kind: "function",
      callSignatures: [{ returnValueType: { kind: "literal", value: "`return-${string}`" } }],
    });
  });
});
