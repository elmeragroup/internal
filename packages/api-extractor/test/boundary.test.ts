import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  declarationBoundaryViolations,
  effectImportViolations,
  packageSourceFiles,
  publicDeclarationGraph,
  scanCompilerImports,
  scanValueModuleSpecifiers,
  sourceBoundaryViolations,
  sourceFiles,
} from "../scripts/boundary-scanner.ts";
import { cleanPackageDist } from "../scripts/build.ts";
import { assertFreshDeclarationOutput } from "../scripts/check-boundary.ts";
import type {
  BackendCompilerOperations,
  BackendExtractionSession,
  BackendNodeHandle,
  BackendSymbolHandle,
  BackendSignatureHandle,
  BackendTypeHandle,
} from "../src/backend/contracts.ts";
import { parseModule } from "../src/parser.ts";

describe("compiler boundary", () => {
  it("catches every compiler import spelling, including side-effect and template forms", () => {
    const mutations = [
      'import value from "typescript/unstable/sync";',
      'import type { API } from "typescript/unstable/sync";',
      'import "typescript/unstable/sync";',
      'export * from "typescript/unstable/sync";',
      'const dynamic = import("typescript/unstable/sync");',
      'const templated = import(`typescript/unstable/${"sync"}`);',
      'const required = require("typescript/unstable/sync");',
    ];

    for (const mutation of mutations) {
      expect(scanCompilerImports(mutation), mutation).not.toEqual([]);
    }
    expect(scanCompilerImports('import "typescript";')).not.toEqual([]);
    expect(scanCompilerImports('import "typescriptx";')).toEqual([]);
  });

  it("scans compiler imports in every supported source extension", () => {
    for (const extension of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) {
      expect(
        sourceBoundaryViolations(
          `/virtual/source${extension}`,
          'import type { API } from "typescript/unstable/sync";'
        )
      ).toEqual([expect.objectContaining({ path: `/virtual/source${extension}` })]);
    }
  });

  it("rejects parse leaf imports of the top-level resolver across module spellings", () => {
    const leafPaths = ["/virtual/src/parse/object-resolver.ts", "/virtual/src/parse/fallback.ts"];
    const mutations = [
      'import { resolve } from "./resolver.ts";',
      'const resolver = import("./resolver.js");',
      'const resolver = require("./nested/../resolver");',
    ];

    for (const path of leafPaths) {
      for (const mutation of mutations) {
        expect(sourceBoundaryViolations(path, mutation), `${path}: ${mutation}`).toEqual([
          {
            path,
            reason: "parse leaf imports top-level resolver",
          },
        ]);
      }
    }
    expect(
      sourceBoundaryViolations(
        "/virtual/src/parse/object-resolver.ts",
        'import type { ResolverContext } from "./contracts.ts";'
      )
    ).toEqual([]);
    expect(
      sourceBoundaryViolations(
        "/virtual/test/fallback.ts",
        'import { resolverFixture } from "./resolver.ts";'
      )
    ).toEqual([]);
  });

  it("keeps the parser and canonicalizer free of Effect imports", () => {
    // `src/parse/**` and `src/canonical/**` are synchronous and compiler-free;
    // they also use no Effect module, so a replacement backend or a plain
    // script can run the resolver without the Effect runtime or data types.
    const packageDirectory = join(import.meta.dirname, "..");
    const entries = ["src/parse", "src/canonical"].flatMap((directory) =>
      sourceFiles(join(packageDirectory, directory))
    );
    expect(effectImportViolations(entries)).toEqual([]);
  });

  it("classifies each import statement on its own, not by an earlier `import type`", () => {
    // One `import type` used to mark every LATER specifier in the file
    // type-only, which hid real value imports: nearly every `src/parse/**`
    // file opens with an `import type`.
    expect(
      scanValueModuleSpecifiers('import type { A } from "./a.ts";\nimport { Data } from "effect";\n')
    ).toEqual(["effect"]);
    expect(
      scanValueModuleSpecifiers('import type { A } from "./a.ts";\nconst d = require("effect");\n')
    ).toEqual(["effect"]);
    expect(
      scanValueModuleSpecifiers('import type { A } from "./a.ts";\nconst d = import("effect");\n')
    ).toEqual(["effect"]);
    expect(
      scanValueModuleSpecifiers('import type { A } from "./a.ts";\nexport type { B } from "./b.ts";\n')
    ).toEqual([]);
    expect(
      scanValueModuleSpecifiers('import { type A, type B } from "./a.ts";\nimport { Data } from "effect";\n')
    ).toEqual(["effect"]);
    expect(
      scanValueModuleSpecifiers('import type {\n  A,\n} from "./a.ts";\nimport { Data } from "effect";\n')
    ).toEqual(["effect"]);
  });

  it("retains a default import when the named bindings are type-only", () => {
    expect(scanValueModuleSpecifiers('import Default, { type Thing } from "./bridge.js";')).toEqual([
      "./bridge.js",
    ]);
    expect(
      scanValueModuleSpecifiers('import Default, { type Thing as T, type Other } from "./bridge.js";')
    ).toEqual(["./bridge.js"]);
    expect(scanValueModuleSpecifiers('import Default, {} from "./bridge.js";')).toEqual(["./bridge.js"]);
    expect(scanValueModuleSpecifiers('import Default from "./bridge.js";')).toEqual(["./bridge.js"]);
    expect(scanValueModuleSpecifiers('import Default, * as NS from "./bridge.js";')).toEqual(["./bridge.js"]);
    expect(scanValueModuleSpecifiers('import { value, type Thing } from "./bridge.js";')).toEqual([
      "./bridge.js",
    ]);
    expect(scanValueModuleSpecifiers('import Default,\n  { type Thing } from "./bridge.js";')).toEqual([
      "./bridge.js",
    ]);
    expect(
      scanValueModuleSpecifiers('import Default, /* type-looking */ { type Thing } from "./bridge.js";')
    ).toEqual(["./bridge.js"]);
    expect(
      scanValueModuleSpecifiers(
        'import type { A } from "./a.ts";\nimport Default, { type Thing } from "./bridge.js";\n'
      )
    ).toEqual(["./bridge.js"]);
    expect(scanValueModuleSpecifiers('import "./bridge.js";')).toEqual(["./bridge.js"]);
    expect(scanValueModuleSpecifiers('const d = import("./bridge.js");')).toEqual(["./bridge.js"]);
    expect(scanValueModuleSpecifiers('const d = require("./bridge.js");')).toEqual(["./bridge.js"]);
    expect(scanValueModuleSpecifiers('import { type Thing, type Other } from "./bridge.js";')).toEqual([]);
    expect(scanValueModuleSpecifiers('import type Default from "./bridge.js";')).toEqual([]);
    expect(scanValueModuleSpecifiers('export type { Thing } from "./bridge.js";')).toEqual([]);
  });

  it("reports a transitive Effect import reached through a file that opens with `import type`", () => {
    const directory = mkdtempSync(join(tmpdir(), "api-extractor-effect-anchored-"));
    try {
      const parseDirectory = join(directory, "src/parse");
      mkdirSync(parseDirectory, { recursive: true });
      const leafPath = join(parseDirectory, "leaf.ts");
      const helperPath = join(directory, "src/errors.ts");
      writeFileSync(
        leafPath,
        'import type { Model } from "../model.ts";\nimport { fail } from "../errors.ts";\nexport const leaf: Model = fail;\n'
      );
      writeFileSync(
        helperPath,
        'import type { Cause } from "./cause.ts";\nimport { Data } from "effect";\nexport const fail = Data;\n'
      );

      expect(effectImportViolations([leafPath])).toEqual([
        {
          path: helperPath,
          reason: "Effect import effect",
        },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails on a transitive Effect import from parse", () => {
    const directory = mkdtempSync(join(tmpdir(), "api-extractor-effect-boundary-"));
    try {
      const parseDirectory = join(directory, "src/parse");
      mkdirSync(parseDirectory, { recursive: true });
      const leafPath = join(parseDirectory, "leaf.ts");
      const helperPath = join(directory, "src/errors.ts");
      writeFileSync(leafPath, 'import { fail } from "../errors.ts";\nexport const leaf = fail;\n');
      writeFileSync(helperPath, 'import { Data } from "effect";\nexport const fail = Data;\n');

      expect(effectImportViolations([leafPath])).toEqual([
        {
          path: helperPath,
          reason: "Effect import effect",
        },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not treat a type-only import of an Effect module as a parse-layer leak", () => {
    const directory = mkdtempSync(join(tmpdir(), "api-extractor-effect-typeonly-"));
    try {
      const parseDirectory = join(directory, "src/parse");
      mkdirSync(parseDirectory, { recursive: true });
      const leafPath = join(parseDirectory, "leaf.ts");
      const modelPath = join(directory, "src/model.ts");
      writeFileSync(
        leafPath,
        'import type { SemanticType } from "../model.ts";\nexport type T = SemanticType;\n'
      );
      writeFileSync(
        modelPath,
        'import { Schema } from "effect";\nexport type SemanticType = typeof Schema.String;\n'
      );

      expect(scanValueModuleSpecifiers(readFileSync(leafPath, "utf8"))).toEqual([]);
      expect(effectImportViolations([leafPath])).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports a transitive Effect import reached through a mixed default and type import", () => {
    const directory = mkdtempSync(join(tmpdir(), "api-extractor-effect-mixed-"));
    try {
      const parseDirectory = join(directory, "src/parse");
      mkdirSync(parseDirectory, { recursive: true });
      const leafPath = join(parseDirectory, "leaf.ts");
      const helperPath = join(directory, "src/bridge.ts");
      writeFileSync(
        leafPath,
        'import Bridge, { type Thing } from "../bridge.js";\nexport const leaf = Bridge;\nexport type T = Thing;\n'
      );
      writeFileSync(
        helperPath,
        'import { Data } from "effect";\nexport type Thing = string;\nexport default Data;\n'
      );

      expect(effectImportViolations([leafPath])).toEqual([
        {
          path: helperPath,
          reason: "Effect import effect",
        },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not treat a wholly type-only import of a mixed bridge as a parse-layer leak", () => {
    const directory = mkdtempSync(join(tmpdir(), "api-extractor-effect-mixed-typeonly-"));
    try {
      const parseDirectory = join(directory, "src/parse");
      mkdirSync(parseDirectory, { recursive: true });
      const leafPath = join(parseDirectory, "leaf.ts");
      const helperPath = join(directory, "src/bridge.ts");
      writeFileSync(leafPath, 'import type { Thing } from "../bridge.js";\nexport type T = Thing;\n');
      writeFileSync(
        helperPath,
        'import { Data } from "effect";\nexport type Thing = typeof Data;\nexport default Data;\n'
      );

      expect(scanValueModuleSpecifiers(readFileSync(leafPath, "utf8"))).toEqual([]);
      expect(effectImportViolations([leafPath])).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("scans package scripts, tests, and root config while excluding fixture data", () => {
    const directory = mkdtempSync(join(tmpdir(), "api-extractor-scan-"));
    try {
      for (const relativePath of [
        "src/adapter.ts",
        "scripts/check.ts",
        "test/check.test.ts",
        "vitest.config.ts",
      ]) {
        const path = join(directory, relativePath);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, 'import type { API } from "typescript/unstable/sync";\n');
      }
      const fixturePath = join(directory, "test/fixtures/mutation.ts");
      mkdirSync(join(directory, "test/fixtures"), { recursive: true });
      writeFileSync(fixturePath, "const mutation = 'import \"typescript/unstable/sync\";';\n");

      const paths = packageSourceFiles(directory);
      expect(paths).toEqual(
        expect.arrayContaining([
          join(directory, "src/adapter.ts"),
          join(directory, "scripts/check.ts"),
          join(directory, "test/check.test.ts"),
          join(directory, "vitest.config.ts"),
        ])
      );
      expect(paths).not.toContain(fixturePath);
      const violations = paths.flatMap((path) => sourceBoundaryViolations(path, readFileSync(path, "utf8")));
      expect(violations).toHaveLength(4);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("walks transitive declaration imports used by exported declarations", () => {
    const directory = mkdtempSync(join(tmpdir(), "api-extractor-boundary-"));
    writeFileSync(
      join(directory, "index.d.ts"),
      'export interface Public extends import("./one.js").One {}\n'
    );
    writeFileSync(join(directory, "one.js"), "export const runtime = true;\n");
    writeFileSync(
      join(directory, "one.d.ts"),
      'import type { Two } from "./two.js"; export interface One extends Two {}\n'
    );
    writeFileSync(
      join(directory, "two.d.ts"),
      'import type { Leak } from "./backend/contracts.js"; export type Two = Leak;\n'
    );

    const graph = publicDeclarationGraph(join(directory, "index.d.ts"));
    expect(graph).toEqual([
      join(directory, "index.d.ts"),
      join(directory, "one.d.ts"),
      join(directory, "two.d.ts"),
    ]);
    expect(declarationBoundaryViolations(graph[2] ?? "", readFileSync(graph[2] ?? "", "utf8"))).toEqual(
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- the fake backend deliberately uses opaque test handles.
      expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining("imports") })])
    );
  });

  it("rejects stale declarations after a source change", () => {
    const directory = mkdtempSync(join(tmpdir(), "api-extractor-clean-emit-"));
    try {
      const sourceDirectory = join(directory, "src");
      const declarationDirectory = join(directory, "dist");
      const sourcePath = join(sourceDirectory, "index.ts");
      const declarationPath = join(declarationDirectory, "index.d.ts");
      const tsconfigPath = join(directory, "tsconfig.json");
      mkdirSync(sourceDirectory, { recursive: true });
      mkdirSync(declarationDirectory, { recursive: true });
      writeFileSync(
        tsconfigPath,
        JSON.stringify({
          compilerOptions: {
            declaration: true,
            declarationMap: true,
            emitDeclarationOnly: true,
            module: "ESNext",
            moduleResolution: "Bundler",
            outDir: "dist",
            rootDir: "src",
            strict: true,
            target: "ES2022",
          },
          include: ["src"],
        })
      );
      writeFileSync(sourcePath, "export type Value = string;\n");
      writeFileSync(declarationPath, "export type Value = string;\n//# sourceMappingURL=index.d.ts.map");
      expect(() =>
        assertFreshDeclarationOutput({
          tsconfigPath,
          cwd: directory,
          declarationDirectory,
        })
      ).not.toThrow();

      writeFileSync(sourcePath, "export type Value = number;\n");
      expect(() =>
        assertFreshDeclarationOutput({
          tsconfigPath,
          cwd: directory,
          declarationDirectory,
        })
      ).toThrow(/stale/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("cleans stale declarations from only the package dist before building", () => {
    const directory = mkdtempSync(join(tmpdir(), "api-extractor-build-clean-"));
    try {
      const packageDist = join(directory, "package", "dist");
      const unrelated = join(directory, "keep.txt");
      mkdirSync(join(packageDist, "src/backend"), { recursive: true });
      writeFileSync(join(packageDist, "src/backend/tsgo.d.ts"), "stale");
      writeFileSync(unrelated, "keep");

      cleanPackageDist(packageDist);

      expect(existsSync(packageDist)).toBe(false);
      expect(existsSync(unrelated)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("catches compiler/backend leaks through a transitive declaration re-export", () => {
    const declaration = `export * as leaked from "./backend/contracts.ts";`;
    const importDeclaration = `export type Leaked = import("./backend/contracts.ts").BackendModuleDraft;`;
    const violations = declarationBoundaryViolations("/virtual/leak.d.ts", declaration);
    const importViolations = declarationBoundaryViolations("/virtual/import-leak.d.ts", importDeclaration);

    expect(violations).toEqual(
      expect.arrayContaining([
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- the fake backend deliberately uses opaque test handles.
        expect.objectContaining({ reason: expect.stringContaining("public declaration") }),
      ])
    );
    expect(importViolations).toEqual(
      expect.arrayContaining([
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- the fake backend deliberately uses opaque test handles.
        expect.objectContaining({ reason: expect.stringContaining("imports") }),
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- the fake backend deliberately uses opaque test handles.
        expect.objectContaining({ reason: expect.stringContaining("BackendModuleDraft") }),
      ])
    );
  });

  it("keeps module resolution required on the backend extraction session", () => {
    expectTypeOf<keyof BackendExtractionSession>().toEqualTypeOf<
      "readModule" | "compiler" | "resolveModule" | "close"
    >();
    expectTypeOf<Pick<BackendExtractionSession, "resolveModule">>().toEqualTypeOf<
      Required<Pick<BackendExtractionSession, "resolveModule">>
    >();
  });

  it("runs parser policy against a replacement backend with no compiler dependency", () => {
    // SAFETY: replacement graph identities are intentionally opaque sentinels.
    const valueSymbol = {} as BackendSymbolHandle;
    // SAFETY: replacement graph identities are intentionally opaque sentinels.
    const runtimeSymbol = {} as BackendSymbolHandle;
    const compiler: BackendCompilerOperations = {
      setErrorContext: () => undefined,
      documentationOfSymbol: () => undefined,
      enumFacts: () => undefined,
      constructSignaturesOfType: () => [],
      documentationOfNode: () => undefined,
      documentationOfParameter: () => undefined,
      typeOfSymbol: () => undefined,
      typeAtNode: () => undefined,
      typeFacts: () => ({ flags: ["Unknown"], intrinsic: "unknown" }),
      symbolFacts: (symbol) => ({
        name: symbol === valueSymbol ? "Value" : "RuntimeValue",
        flags: [],
        declarationPaths: ["/virtual/source.d.ts"],
        declarations: [],
      }),
      symbolOrigin: (symbol) => ({
        identity: { name: symbol === valueSymbol ? "Value" : "RuntimeValue", namespaces: [] },
      }),
      declaringParentIsClass: () => false,
      nodeFacts: () => ({ kind: "unknown", text: "", filePath: "/virtual/source.d.ts", line: 1, column: 1 }),
      nodeKind: () => "unknown",
      typeNameFacts: () => undefined,
      // SAFETY: replacement graph identities are intentionally opaque sentinels.
      signaturesOfType: () => [] as readonly BackendSignatureHandle[],
      // SAFETY: replacement graph identities are intentionally opaque sentinels.
      signatureFacts: () => ({ parameters: [], returnType: {} as BackendTypeHandle, typeParameters: [] }),
      declarationOwnership: () => ({ kind: "project" }),
      propertiesOfType: () => [],
      propertyType: () => undefined,
      indexSignaturesOfType: () => [],
      baseConstraintOfType: () => undefined,
      isArrayType: () => false,
      isReadonlyType: () => false,
      typeToString: () => "unknown",
    };
    const module = parseModule(
      {
        compiler,
        readModule: () => ({
          name: "virtual/input",
          imports: ["./source.js"],
          typeOnlyStarExports: ["./source.js"],
          exports: [
            {
              name: "Value",
              symbol: valueSymbol,
              declarationSourcePath: "/virtual/source.d.ts",
              pureType: true,
            },
            {
              name: "RuntimeValue",
              symbol: runtimeSymbol,
              declarationSourcePath: "/virtual/source.d.ts",
            },
          ],
        }),
        resolveModule: () => ({ filePath: "/virtual/source.d.ts" }),
        close: () => undefined,
      },
      "/virtual/input.d.ts"
    );

    expect(module.module.exports.map((entry) => entry.name)).toEqual(["Value"]);
    expect(module.module.imports).toEqual(["./source.js"]);
  });

  it("resolves an opaque replacement type graph through the real resolver", () => {
    // SAFETY: replacement graph identities are intentionally opaque sentinels.
    const widgetSymbol = {} as BackendSymbolHandle;
    // SAFETY: replacement graph identities are intentionally opaque sentinels.
    const propsSymbol = {} as BackendSymbolHandle;
    // SAFETY: replacement graph identities are intentionally opaque sentinels.
    const valueSymbol = {} as BackendSymbolHandle;
    // SAFETY: replacement graph identities are intentionally opaque sentinels.
    const reactSymbol = {} as BackendSymbolHandle;
    // SAFETY: replacement graph identities are intentionally opaque sentinels.
    const widgetType = {} as BackendTypeHandle;
    // SAFETY: replacement graph identities are intentionally opaque sentinels.
    const propsType = {} as BackendTypeHandle;
    // SAFETY: replacement graph identities are intentionally opaque sentinels.
    const valueType = {} as BackendTypeHandle;
    // SAFETY: replacement graph identities are intentionally opaque sentinels.
    const reactType = {} as BackendTypeHandle;
    // SAFETY: replacement graph identities are intentionally opaque sentinels.
    const signature = {} as BackendSignatureHandle;
    // SAFETY: replacement graph identities are intentionally opaque sentinels.
    const propsNode = {} as BackendNodeHandle;
    // SAFETY: replacement graph identities are intentionally opaque sentinels.
    const valueNode = {} as BackendNodeHandle;
    // SAFETY: replacement graph identities are intentionally opaque sentinels.
    const reactNode = {} as BackendNodeHandle;
    const compiler: BackendCompilerOperations = {
      setErrorContext: () => undefined,
      documentationOfSymbol: () => undefined,
      enumFacts: () => undefined,
      constructSignaturesOfType: () => [],
      documentationOfNode: () => undefined,
      documentationOfParameter: () => undefined,
      typeOfSymbol: (symbol) =>
        symbol === widgetSymbol ? widgetType : symbol === propsSymbol ? propsType : undefined,
      typeAtNode: () => undefined,
      typeFacts: (type) => {
        if (type === valueType) return { flags: ["String"], intrinsic: "string" };
        if (type === reactType) return { flags: ["Object"], isObject: true, symbol: reactSymbol };
        if (type === propsType) return { flags: ["Object"], isObject: true, symbol: propsSymbol };
        return {
          flags: ["Object"],
          isObject: true,
          symbol: widgetSymbol,
        };
      },
      symbolFacts: (symbol) => {
        if (symbol === propsSymbol)
          return {
            name: "Props",
            flags: [],
            declarationPaths: ["/virtual/input.d.ts"],
            declarations: [propsNode],
          };
        if (symbol === valueSymbol)
          return {
            name: "value",
            flags: [],
            declarationPaths: ["/virtual/input.d.ts"],
            declarations: [valueNode],
          };
        if (symbol === reactSymbol)
          return {
            name: "ReactElement",
            flags: [],
            declarationPaths: ["/virtual/node_modules/react/index.d.ts"],
            declarations: [reactNode],
          };
        return { name: "Widget", flags: [], declarationPaths: ["/virtual/input.tsx"], declarations: [] };
      },
      symbolOrigin: (symbol) => ({
        identity: {
          name:
            symbol === propsSymbol
              ? "Props"
              : symbol === valueSymbol
                ? "value"
                : symbol === reactSymbol
                  ? "ReactElement"
                  : "Widget",
          namespaces: [],
        },
      }),
      declaringParentIsClass: () => false,
      nodeFacts: (node) => {
        if (node === propsNode)
          return {
            kind: "interface",
            text: "interface Props {}",
            filePath: "/virtual/input.d.ts",
            line: 1,
            column: 1,
          };
        if (node === valueNode)
          return {
            kind: "property",
            text: "value: string",
            filePath: "/virtual/input.d.ts",
            line: 1,
            column: 1,
          };
        return {
          kind: "interface",
          text: "interface ReactElement {}",
          filePath: "/virtual/node_modules/react/index.d.ts",
          line: 1,
          column: 1,
        };
      },
      nodeKind: (node) => {
        if (node === propsNode) return "interface";
        if (node === valueNode) return "property";
        return "interface";
      },
      typeNameFacts: (type) =>
        type === reactType
          ? { name: "ReactElement", namespaces: ["React"] }
          : type === propsType
            ? { name: "Props", namespaces: ["Widget"] }
            : undefined,
      signaturesOfType: (type) => (type === widgetType ? [signature] : []),
      signatureFacts: () => ({ parameters: [propsSymbol], returnType: reactType, typeParameters: [] }),
      declarationOwnership: () => ({ kind: "project" }),
      propertiesOfType: (type) => (type === propsType ? [valueSymbol] : []),
      propertyType: (property) => (property === valueSymbol ? valueType : undefined),
      indexSignaturesOfType: () => [],
      baseConstraintOfType: () => undefined,
      isArrayType: () => false,
      isReadonlyType: () => false,
      typeToString: (type) => (type === valueType ? "string" : "unknown"),
    };
    const module = parseModule(
      {
        compiler,
        readModule: () => ({ name: "virtual/input", exports: [{ name: "Widget", symbol: widgetSymbol }] }),
        resolveModule: () => undefined,
        close: () => undefined,
      },
      "/virtual/input.tsx"
    );

    expect(module.module.exports[0]?.type).toEqual({
      kind: "component",
      props: [{ name: "value", type: { kind: "intrinsic", intrinsic: "string" }, optional: false }],
    });
  });
});
