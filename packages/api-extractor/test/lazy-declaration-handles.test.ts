import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type {
  BackendExtractionSession,
  BackendNodeFacts,
  BackendProject,
  BackendSymbolHandle,
  BackendSymbolFacts,
  BackendSymbolOrigin,
} from "../src/backend/contracts.ts";
import { openTsgoProject } from "../src/backend/ts7/project.ts";
import { resolveModuleDraft } from "../src/parser.ts";
import { extractFixture } from "./support/extract.ts";

const fixtureDirectory = resolve(import.meta.dirname, "fixtures/backend-lazy-declarations");
const tsconfigPath = resolve(fixtureDirectory, "tsconfig.json");
const inputPath = resolve(fixtureDirectory, "input.ts");
const packageFixtureDirectory = resolve(import.meta.dirname, "fixtures/package-selective-external-types");
const packageTsconfigPath = resolve(packageFixtureDirectory, "tsconfig.json");
const packageInputPath = resolve(packageFixtureDirectory, "input.ts");
const virtualPackagePath = resolve(packageFixtureDirectory, "node_modules/unknown-owner/index.d.ts");
const virtualDeclarationPath = resolve(packageFixtureDirectory, "external-types/unknown-owner/index.d.ts");
const genericFixtureDirectory = resolve(
  import.meta.dirname,
  "fixtures/generic-function-and-interface-resolution"
);
const genericTsconfigPath = resolve(import.meta.dirname, "fixtures/generics-tsconfig.json");
const genericInputPath = resolve(genericFixtureDirectory, "input.ts");
const reviewFixtureDirectory = resolve(import.meta.dirname, "fixtures/mixed-repo-provenance");
const reviewTsconfigPath = resolve(reviewFixtureDirectory, "tsconfig.json");
const reviewInputPath = resolve(reviewFixtureDirectory, "input.tsx");

function sourceFileTotals(project: BackendProject) {
  const totals = project.getTimingInfo?.().totals;
  if (totals === undefined) throw new Error("Timing evidence is unavailable");
  return { sourceFilesFetched: totals.sourceFilesFetched, nodesFetched: totals.nodesFetched };
}

function requestCount(project: BackendProject): number {
  const count = project.getTimingInfo?.().totals.requestCount;
  if (count === undefined) throw new Error("Timing evidence is unavailable");
  return count;
}

function exportSymbol(
  session: BackendExtractionSession,
  exportName: string,
  modulePath = inputPath
): BackendSymbolHandle {
  const symbol = session.readModule(modulePath).exports.find((entry) => entry.name === exportName)?.symbol;
  if (symbol === undefined) throw new Error(`Missing ${exportName} export`);
  return symbol;
}

function globalPromise(session: BackendExtractionSession) {
  const globalScope = exportSymbol(session, "GlobalScope");
  const globalType = session.compiler.typeOfSymbol(globalScope, true);
  if (globalType === undefined) throw new Error("Missing global scope type");
  const symbol = session.compiler
    .propertiesOfType(globalType)
    .find((candidate) => session.compiler.symbolFacts(candidate).name === "Promise");
  if (symbol === undefined) throw new Error("Missing global Promise symbol");
  const declaration = session.compiler
    .symbolFacts(symbol)
    .declarations.find((candidate) => session.compiler.nodeKind(candidate) === "variable");
  if (declaration === undefined) throw new Error("Missing global Promise declaration");
  return { symbol, declaration };
}

type FrozenDataRecord = BackendNodeFacts | BackendSymbolFacts | BackendSymbolOrigin;

function expectFrozenDataRecord(value: FrozenDataRecord): void {
  expect(Object.isFrozen(value)).toBe(true);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    expect(Object.hasOwn(descriptor, "get")).toBe(false);
    expect(Object.hasOwn(descriptor, "set")).toBe(false);
    expect(descriptor.configurable).toBe(false);
    if ("value" in descriptor) expect(descriptor.writable).toBe(false);
  }
}

describe("lazy TypeScript declaration handles", () => {
  it("preserves the exact public model while rejected global declarations stay lazy", async () => {
    const result = await extractFixture({ tsconfigPath }, inputPath);

    expect(result.module.exports).toEqual([
      {
        name: "GlobalScope",
        type: {
          kind: "object",
          typeName: { name: "globalThis" },
          properties: [
            {
              name: "globalThis",
              type: { kind: "object", typeName: { name: "globalThis" }, properties: [] },
              optional: false,
            },
            { name: "undefined", type: { kind: "intrinsic", intrinsic: "undefined" }, optional: false },
          ],
        },
      },
      {
        name: "ProjectOwned",
        type: {
          kind: "object",
          typeName: { name: "ProjectOwned" },
          properties: [{ name: "value", type: { kind: "intrinsic", intrinsic: "string" }, optional: false }],
        },
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("classifies a default-library VariableDeclaration before resolving its source file", () => {
    const project = openTsgoProject({ tsconfigPath, collectTiming: true });
    try {
      const session = project.openExtraction();
      const { symbol, declaration } = globalPromise(session);
      const beforeHead = sourceFileTotals(project);

      expect(session.compiler.nodeKind(declaration)).toBe("variable");
      expect(session.compiler.declarationOwnership(declaration)).toEqual({
        kind: "typescript",
        library: "standard-library",
      });
      const promiseConstructor = session.compiler.typeOfSymbol(symbol, false);
      if (promiseConstructor === undefined) throw new Error("Missing Promise constructor type");
      expect(session.compiler.typeToString(promiseConstructor)).toBe("PromiseConstructor");
      expect(sourceFileTotals(project)).toEqual(beforeHead);

      const text = session.compiler.nodeFacts(declaration).text;
      const afterBody = sourceFileTotals(project);
      expect(text).toContain("Promise");
      expect(afterBody.sourceFilesFetched).toBe(beforeHead.sourceFilesFetched + 1);
      expect(afterBody.nodesFetched).toBeGreaterThan(beforeHead.nodesFetched);
      session.close();
    } finally {
      project.close();
    }
  });

  it("interns equivalent declaration handles and deduplicates their fact reads", () => {
    const project = openTsgoProject({ tsconfigPath, collectTiming: true });
    try {
      const session = project.openExtraction();
      const { symbol } = globalPromise(session);
      const facts = session.compiler.symbolFacts(symbol);
      const declaration = facts.declarations.find(
        (candidate) => session.compiler.nodeKind(candidate) === "variable"
      );
      if (facts.valueDeclaration === undefined || declaration === undefined) {
        throw new Error("Missing Promise value declaration");
      }

      expect(facts.valueDeclaration).toBe(declaration);
      const first = session.compiler.nodeFacts(facts.valueDeclaration);
      const afterFirst = project.getTimingInfo?.().totals.requestCount;
      const second = session.compiler.nodeFacts(declaration);
      const afterSecond = project.getTimingInfo?.().totals.requestCount;
      expect(second).toBe(first);
      expect(afterSecond).toBe(afterFirst);
      session.close();
    } finally {
      project.close();
    }
  });

  it("reconciles eager and deferred handles for one type-parameter fact", () => {
    const project = openTsgoProject({ tsconfigPath: genericTsconfigPath, collectTiming: true });
    try {
      const session = project.openExtraction();
      const functionSymbol = exportSymbol(session, "genericFunction", genericInputPath);
      const functionDeclaration = session.compiler.symbolFacts(functionSymbol).declarations[0];
      if (functionDeclaration === undefined) throw new Error("Missing generic function declaration");

      const functionFacts = session.compiler.nodeFacts(functionDeclaration);
      const eagerParameter = functionFacts.typeParameters?.[0];
      if (eagerParameter === undefined) throw new Error("Missing eager type-parameter handle");
      const eagerFacts = session.compiler.nodeFacts(eagerParameter);
      const authoredSymbol = eagerFacts.typeName?.authoredSymbol;
      if (authoredSymbol === undefined) throw new Error("Missing authored type-parameter symbol");
      const deferredParameter = session.compiler.symbolFacts(authoredSymbol).declarations[0];
      if (deferredParameter === undefined) throw new Error("Missing deferred type-parameter handle");
      const beforeDeferredRead = requestCount(project);
      const deferredFacts = session.compiler.nodeFacts(deferredParameter);
      const afterDeferredRead = requestCount(project);

      expect(deferredParameter).toBe(eagerParameter);
      expect(deferredFacts).toBe(eagerFacts);
      expect(afterDeferredRead).toBe(beforeDeferredRead);
      session.close();
    } finally {
      project.close();
    }
  });

  it("answers nodeKind from the handle without resolving the declaration AST", () => {
    const project = openTsgoProject({ tsconfigPath, collectTiming: true });
    try {
      const session = project.openExtraction();
      const { declaration } = globalPromise(session);
      const beforeBody = sourceFileTotals(project);

      expect(session.compiler.nodeKind(declaration)).toBe("variable");
      expect(sourceFileTotals(project)).toEqual(beforeBody);

      const facts = session.compiler.nodeFacts(declaration);
      const afterBody = sourceFileTotals(project);
      expect(facts.kind).toBe("variable");
      expect(facts.text).toContain("Promise");
      expect(afterBody.sourceFilesFetched).toBe(beforeBody.sourceFilesFetched + 1);
      expectFrozenDataRecord(facts);
      session.close();
    } finally {
      project.close();
    }
  });

  it("agrees between nodeKind and nodeFacts().kind for declaration, type, and typeof import handles", () => {
    const root = mkdtempSync(join(tmpdir(), "api-extractor-node-kind-"));
    const project = (() => {
      writeFileSync(join(root, "widget.ts"), "export type Widget = { readonly id: string };\n");
      writeFileSync(
        join(root, "input.ts"),
        [
          'export type WidgetModule = typeof import("./widget");',
          'export type WidgetRef = import("./widget").Widget;',
          "export type Union = string | number;",
          'export type Literal = "on";',
          "export type Callback = (value: number) => void;",
          "export type Keys = keyof Record<string, number>;",
          "export interface Shape { readonly size: number }",
          "export const constant = 1;",
          "",
        ].join("\n")
      );
      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            lib: ["ES2022"],
            module: "ESNext",
            moduleResolution: "Bundler",
            noEmit: true,
            strict: true,
            target: "ES2022",
          },
          include: ["input.ts", "widget.ts"],
        })
      );
      return openTsgoProject({ tsconfigPath: join(root, "tsconfig.json") });
    })();
    try {
      const session = project.openExtraction();
      const modulePath = join(root, "input.ts");
      const declarationOf = (exportName: string) => {
        const declaration = session.compiler.symbolFacts(exportSymbol(session, exportName, modulePath))
          .declarations[0];
        if (declaration === undefined) throw new Error(`Missing ${exportName} declaration`);
        return declaration;
      };
      const typeNodeOf = (exportName: string) => {
        const type = session.compiler.nodeFacts(declarationOf(exportName)).type;
        if (type === undefined) throw new Error(`Missing ${exportName} type node`);
        return type;
      };
      const handles = [
        ["WidgetModule", declarationOf("WidgetModule"), "typeAlias"],
        ["typeof import", typeNodeOf("WidgetModule"), "typeQuery"],
        ["import type", typeNodeOf("WidgetRef"), "type"],
        ["union", typeNodeOf("Union"), "union"],
        ["literal type", typeNodeOf("Literal"), "type"],
        ["function type", typeNodeOf("Callback"), "type"],
        ["keyof", typeNodeOf("Keys"), "typeOperator"],
        ["interface", declarationOf("Shape"), "interface"],
        ["variable", declarationOf("constant"), "variable"],
      ] as const;

      for (const [label, handle, expectedKind] of handles) {
        const facts = session.compiler.nodeFacts(handle);
        expect([label, facts.kind]).toEqual([label, expectedKind]);
        expect([label, session.compiler.nodeKind(handle)]).toEqual([label, facts.kind]);
      }
      session.close();
    } finally {
      project.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps identity and module origin off symbolFacts", () => {
    const project = openTsgoProject({ tsconfigPath: packageTsconfigPath, collectTiming: true });
    try {
      const session = project.openExtraction();
      const externalSymbol = exportSymbol(session, "SelectedOwner", packageInputPath);
      const localSymbol = exportSymbol(session, "WrapperProps", packageInputPath);
      const external = session.compiler.symbolFacts(externalSymbol);
      const local = session.compiler.symbolFacts(localSymbol);

      expect("identity" in external).toBe(false);
      expect("moduleOrigin" in external).toBe(false);
      expect("identity" in local).toBe(false);
      expect("moduleOrigin" in local).toBe(false);
      expect(Object.keys(external)).toEqual([
        "name",
        "flags",
        "declarationPaths",
        "declarations",
        "repositoryRelativeDeclarationPaths",
      ]);
      expect(Object.keys(local)).toEqual([
        "name",
        "flags",
        "declarationPaths",
        "declarations",
        "repositoryRelativeDeclarationPaths",
      ]);
      expectFrozenDataRecord(external);
      expectFrozenDataRecord(local);

      const externalOrigin = session.compiler.symbolOrigin(externalSymbol);
      const localOrigin = session.compiler.symbolOrigin(localSymbol);
      expect(externalOrigin.identity.name).toBe(external.name);
      expect(externalOrigin.moduleOrigin).toEqual({
        moduleSpecifier: "@fixture/selected",
        packageName: "@fixture/selected",
        external: true,
      });
      expect(localOrigin.identity.name).toBe(local.name);
      expect(localOrigin.moduleOrigin).toBeUndefined();
      expectFrozenDataRecord(externalOrigin);
      expectFrozenDataRecord(localOrigin);
      session.close();
    } finally {
      project.close();
    }
  });

  it("reads a declaring class fact without materializing its declaration or full symbol facts", () => {
    const project = openTsgoProject({ tsconfigPath: reviewTsconfigPath, collectTiming: true });
    try {
      const session = project.openExtraction();
      const classSymbol = exportSymbol(session, "ThatClass", reviewInputPath);
      const classType = session.compiler.typeOfSymbol(classSymbol, false);
      if (classType === undefined) throw new Error("Missing ThatClass type");
      const constructor = session.compiler.constructSignaturesOfType(classType)[0];
      if (constructor === undefined) throw new Error("Missing ThatClass constructor");
      const instanceType = session.compiler.signatureFacts(constructor).returnType;
      if (instanceType === undefined) throw new Error("Missing ThatClass instance type");
      const openProperty = session.compiler
        .propertiesOfType(instanceType)
        .find((candidate) => session.compiler.symbolFacts(candidate).name === "open");
      if (openProperty === undefined) throw new Error("Missing ThatClass.open property");
      const facts = session.compiler.symbolFacts(openProperty);
      const before = project.getTimingInfo?.().totals;
      if (before === undefined) throw new Error("Timing evidence is unavailable");

      expect(session.compiler.declaringParentIsClass(openProperty)).toBe(true);

      const after = project.getTimingInfo?.().totals;
      if (after === undefined) throw new Error("Timing evidence is unavailable");
      expect(after.nodesMaterialized).toBe(before.nodesMaterialized);
      expect("identity" in facts).toBe(false);
      expect("moduleOrigin" in facts).toBe(false);
      expect("declaringParentIsClass" in facts).toBe(false);
      session.close();
    } finally {
      project.close();
    }
  });

  it("guards cold declaring class facts after close while preserving cached values", () => {
    const project = openTsgoProject({ tsconfigPath: reviewTsconfigPath, collectTiming: true });
    try {
      const openFacts = () => {
        const session = project.openExtraction();
        const classSymbol = exportSymbol(session, "ThatClass", reviewInputPath);
        const classType = session.compiler.typeOfSymbol(classSymbol, false);
        if (classType === undefined) throw new Error("Missing ThatClass type");
        const constructor = session.compiler.constructSignaturesOfType(classType)[0];
        if (constructor === undefined) throw new Error("Missing ThatClass constructor");
        const instanceType = session.compiler.signatureFacts(constructor).returnType;
        if (instanceType === undefined) throw new Error("Missing ThatClass instance type");
        const openProperty = session.compiler
          .propertiesOfType(instanceType)
          .find((candidate) => session.compiler.symbolFacts(candidate).name === "open");
        if (openProperty === undefined) throw new Error("Missing ThatClass.open property");
        return {
          session,
          facts: session.compiler.symbolFacts(openProperty),
          openProperty,
        };
      };

      const cold = openFacts();
      cold.session.close();
      expect(() => cold.session.compiler.declaringParentIsClass(cold.openProperty)).toThrow(
        /after it closed \(symbolFacts\.declaringParentIsClass\)/u
      );

      const warm = openFacts();
      expect(warm.session.compiler.declaringParentIsClass(warm.openProperty)).toBe(true);
      warm.session.close();
      expect(() => warm.session.compiler.declaringParentIsClass(warm.openProperty)).toThrow(
        /after it closed \(symbolFacts\.declaringParentIsClass\)/u
      );
    } finally {
      project.close();
    }
  });

  it("keeps project ownership exact without materializing a declaration body", () => {
    const project = openTsgoProject({ tsconfigPath, collectTiming: true });
    try {
      const session = project.openExtraction();
      const projectOwned = exportSymbol(session, "ProjectOwned");
      const declaration = session.compiler.symbolFacts(projectOwned).declarations[0];
      if (declaration === undefined) throw new Error("Missing project declaration");
      const before = sourceFileTotals(project);

      expect(session.compiler.nodeFacts(declaration).kind).toBe("interface");
      expect(session.compiler.declarationOwnership(declaration)).toEqual({ kind: "project" });
      expect(sourceFileTotals(project)).toEqual(before);
      session.close();
    } finally {
      project.close();
    }
  });

  it("distinguishes node_modules ownership from a VFS external without a package path", () => {
    const project = openTsgoProject({
      tsconfigPath: packageTsconfigPath,
      collectTiming: true,
      fileSystem: {
        realpath: (path) => (path === virtualPackagePath ? virtualDeclarationPath : undefined),
      },
    });
    try {
      const session = project.openExtraction();
      const dependency = exportSymbol(session, "SelectedOwner", packageInputPath);
      const wrapper = exportSymbol(session, "UnknownOwnerWrapper", packageInputPath);
      const wrapperType = session.compiler.typeOfSymbol(wrapper, true);
      if (wrapperType === undefined) throw new Error("Missing VFS wrapper type");
      const virtualProperty = session.compiler
        .propertiesOfType(wrapperType)
        .find((property) => session.compiler.symbolFacts(property).name === "unknownOwner");
      const virtualType =
        virtualProperty === undefined ? undefined : session.compiler.propertyType(virtualProperty);
      const virtualTypeFacts =
        virtualType === undefined ? undefined : session.compiler.typeFacts(virtualType);
      const virtual = virtualTypeFacts?.aliasSymbol ?? virtualTypeFacts?.symbol;
      if (virtual === undefined) throw new Error("Missing VFS-owned symbol");
      const dependencyDeclaration = session.compiler.symbolFacts(dependency).declarations[0];
      const virtualDeclaration = session.compiler.symbolFacts(virtual).declarations[0];
      if (dependencyDeclaration === undefined || virtualDeclaration === undefined) {
        throw new Error("Missing external ownership declaration");
      }

      expect(session.compiler.declarationOwnership(dependencyDeclaration)).toEqual({
        kind: "dependency",
        packageName: "@fixture/selected",
      });
      expect(session.compiler.declarationOwnership(virtualDeclaration)).toEqual({ kind: "external" });
      session.close();
    } finally {
      project.close();
    }
  });

  it("keeps excluded dependency declaration subtrees unmaterialized while selected expansion is stable", () => {
    const extractWrapper = (
      selection: "deferred" | "selected",
      options?: { readonly includeExternalTypes?: boolean | readonly string[] }
    ) => {
      const project = openTsgoProject({
        tsconfigPath: packageTsconfigPath,
        collectTiming: true,
        fileSystem: {
          realpath: (path) => (path === virtualPackagePath ? virtualDeclarationPath : undefined),
        },
      });
      const session = project.openExtraction();
      try {
        const draft = session.readModule(packageInputPath);
        const entry = draft.exports.find((candidate) => candidate.name === "WrapperProps");
        if (entry === undefined) throw new Error("Missing WrapperProps export");
        const wrapperType = session.compiler.typeOfSymbol(entry.symbol, true);
        if (wrapperType === undefined) throw new Error("Missing WrapperProps type");
        const property = session.compiler
          .propertiesOfType(wrapperType)
          .find((candidate) => session.compiler.symbolFacts(candidate).name === "focusableWhenDisabled");
        if (property === undefined) throw new Error("Missing focusableWhenDisabled property");
        const propertyDeclaration = session.compiler.symbolFacts(property).declarations[0];
        if (propertyDeclaration === undefined) throw new Error("Missing focusableWhenDisabled declaration");
        expect(session.compiler.declarationOwnership(propertyDeclaration)).toEqual({
          kind: "dependency",
          packageName: "@fixture/selected",
        });
        const result = resolveModuleDraft(session, { ...draft, exports: [entry] }, packageInputPath, options);
        const beforeBodyRead = project.getTimingInfo?.().totals.nodesMaterialized;
        if (beforeBodyRead === undefined) throw new Error("Timing evidence is unavailable");
        const declarationText = session.compiler.nodeFacts(propertyDeclaration).text;
        const afterBodyRead = project.getTimingInfo?.().totals.nodesMaterialized;
        if (afterBodyRead === undefined) throw new Error("Timing evidence is unavailable");
        expect(declarationText).toContain("focusableWhenDisabled");
        if (selection === "deferred") {
          // The body read itself is the observable proof: extraction left this
          // dependency declaration deferred, and reading its text now
          // materializes additional source nodes.
          expect(afterBodyRead).toBeGreaterThan(beforeBodyRead);
        } else {
          // Selected expansion reads the declaration facts needed for its
          // semantic property, so the later text observation is already cached.
          expect(afterBodyRead).toBe(beforeBodyRead);
        }
        return result;
      } finally {
        session.close();
        project.close();
      }
    };

    const omitted = extractWrapper("deferred");
    const excluded = extractWrapper("deferred", { includeExternalTypes: ["@fixture/not-selected"] });
    const selected = extractWrapper("selected", { includeExternalTypes: ["@fixture/selected"] });

    expect(excluded).toEqual(omitted);
    expect(omitted.module.exports[0]?.type).toEqual({
      kind: "object",
      typeName: { name: "WrapperProps" },
      properties: [{ name: "localLabel", type: { kind: "intrinsic", intrinsic: "string" }, optional: false }],
    });
    const selectedType = selected.module.exports[0]?.type;
    if (selectedType?.kind !== "object") throw new Error("Expected selected WrapperProps object");
    expect(selectedType.properties.map((property) => property.name)).toEqual([
      "focusableWhenDisabled",
      "foreignDetail",
      "onAction",
      "localLabel",
    ]);
    expect(selectedType.properties.find((property) => property.name === "focusableWhenDisabled")).toEqual({
      name: "focusableWhenDisabled",
      type: {
        kind: "union",
        types: [
          { kind: "intrinsic", intrinsic: "boolean" },
          { kind: "intrinsic", intrinsic: "undefined" },
        ],
      },
      optional: true,
      documentation: {
        description: "Allows the primitive to remain focusable while disabled.",
        defaultValue: "false",
        tags: [],
      },
    });
  });

  it("gates a declined named object before dependency declaration bodies", () => {
    const project = openTsgoProject({
      tsconfigPath: packageTsconfigPath,
      collectTiming: true,
      fileSystem: {
        realpath: (path) => (path === virtualPackagePath ? virtualDeclarationPath : undefined),
      },
    });
    try {
      const session = project.openExtraction();
      const draft = session.readModule(packageInputPath);
      const entry = draft.exports.find((candidate) => candidate.name === "WrapperProps");
      if (entry === undefined) throw new Error("Missing WrapperProps export");
      const wrapperType = session.compiler.typeOfSymbol(entry.symbol, true);
      if (wrapperType === undefined) throw new Error("Missing WrapperProps type");
      const property = session.compiler
        .propertiesOfType(wrapperType)
        .find((candidate) => session.compiler.symbolFacts(candidate).name === "focusableWhenDisabled");
      if (property === undefined) throw new Error("Missing focusableWhenDisabled property");
      const declaration = session.compiler.symbolFacts(property).declarations[0];
      if (declaration === undefined) throw new Error("Missing focusableWhenDisabled declaration");
      expect(session.compiler.declarationOwnership(declaration)).toEqual({
        kind: "dependency",
        packageName: "@fixture/selected",
      });

      const result = resolveModuleDraft(session, { ...draft, exports: [entry] }, packageInputPath, {
        includeExternalTypes: true,
        shouldResolveObject: ({ name }) => (name === "WrapperProps" ? false : undefined),
      });
      expect(result.module.exports[0]?.type).toEqual({
        kind: "object",
        typeName: { name: "WrapperProps" },
        properties: [],
      });

      const beforeBodyRead = project.getTimingInfo?.().totals.nodesMaterialized;
      if (beforeBodyRead === undefined) throw new Error("Timing evidence is unavailable");
      const declarationText = session.compiler.nodeFacts(declaration).text;
      const afterBodyRead = project.getTimingInfo?.().totals.nodesMaterialized;
      if (afterBodyRead === undefined) throw new Error("Timing evidence is unavailable");
      expect(declarationText).toContain("focusableWhenDisabled");
      expect(afterBodyRead).toBeGreaterThan(beforeBodyRead);
      session.close();
    } finally {
      project.close();
    }
  });

  it("rejects lazy declarations across sessions and after close", () => {
    const project = openTsgoProject({ tsconfigPath, collectTiming: true });
    try {
      const first = project.openExtraction();
      const { symbol, declaration } = globalPromise(first);
      const facts = first.compiler.symbolFacts(symbol);
      const lazyNode = first.compiler.nodeFacts(declaration);
      expect(Object.isFrozen(facts)).toBe(true);

      const second = project.openExtraction();
      expect(() => second.compiler.declarationOwnership(declaration)).toThrow(
        /Invalid node compiler handle/u
      );
      second.close();

      first.close();
      expect(() => first.compiler.declarationOwnership(declaration)).toThrow(/after it closed/u);
      expect(() => first.compiler.nodeFacts(declaration)).toThrow(/after it closed/u);
      expect(() => first.compiler.symbolOrigin(symbol)).toThrow(/after it closed/u);
      expect(lazyNode.kind).toBe("variable");
      expect("identity" in facts).toBe(false);
      expect(Object.isFrozen(facts)).toBe(true);
    } finally {
      project.close();
    }
  });
});
