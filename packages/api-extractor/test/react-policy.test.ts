import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { BackendModuleOrigin } from "../src/backend/contracts.ts";
import type { ExtractorOptions, ExtractionResult, SemanticType } from "../src/index.ts";
import type { ParserSymbolOrigin } from "../src/parse/react-policy.ts";
import { isReactWrapperType } from "../src/parse/react-policy.ts";
import { extractFixture } from "./support/extract.ts";

const lookalikeFixtureRoot = resolve(import.meta.dirname, "fixtures/react-policy-non-react-dependency");
const lookalikeInput = resolve(lookalikeFixtureRoot, "input.ts");
const lookalikeTsconfig = resolve(lookalikeFixtureRoot, "tsconfig.json");

type LookalikeOptions = ExtractorOptions;

function extractLookalikes(options: LookalikeOptions = {}): Promise<ExtractionResult> {
  return extractFixture({ tsconfigPath: lookalikeTsconfig }, lookalikeInput, options);
}

const dependencyDeclaration =
  "test/fixtures/react-policy-non-react-dependency/node_modules/non-react-lookalikes/index.d.ts";
const inputDeclaration = "test/fixtures/react-policy-non-react-dependency/input.ts";
const lookalikeTypes = [
  ["LookalikeFC", "FC"],
  ["LookalikeFunctionComponent", "FunctionComponent"],
  ["LookalikeForwardRefExoticComponent", "ForwardRefExoticComponent"],
  ["LookalikeMemoExoticComponent", "MemoExoticComponent"],
  ["LookalikeNamedExoticComponent", "NamedExoticComponent"],
] as const;
const lookalikeCalls = [
  ["LookalikeMemo", "MemoComponentSurface"],
  ["LookalikeForwardRef", "ForwardRefComponentSurface"],
  ["LookalikeNamespacedMemo", "MemoComponentSurface"],
  ["LookalikeNamespacedForwardRef", "ForwardRefComponentSurface"],
] as const;

function exportEntry(result: ExtractionResult, name: string) {
  const entry = result.module.exports.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`missing export ${name}`);
  return entry;
}

function functionProps(type: SemanticType): SemanticType {
  if (type.kind !== "function") throw new Error(`expected a function, got ${type.kind}`);
  if (type.callSignatures.length !== 1) throw new Error("expected one bounded call signature");
  const signature = type.callSignatures[0];
  if (signature === undefined) throw new Error("expected a call signature");
  const parameter = signature.parameters[0];
  if (parameter === undefined) throw new Error("expected a props parameter");
  return parameter.type;
}

function expectDependencyProvenance(result: ExtractionResult, path: readonly string[]) {
  // The public model intentionally has no package field; this durable path is
  // the ownership evidence for the vendored dependency declaration.
  const entry = result.provenance.find(
    (candidate) => JSON.stringify(candidate.path) === JSON.stringify(path)
  );
  expect(entry?.declarations.map((declaration) => declaration.path)).toEqual([dependencyDeclaration]);
}

function expectInputProvenance(result: ExtractionResult, path: readonly string[]) {
  const entry = result.provenance.find(
    (candidate) => JSON.stringify(candidate.path) === JSON.stringify(path)
  );
  expect(entry?.declarations.map((declaration) => declaration.path)).toEqual([inputDeclaration]);
}

function symbolOrigin(name: string, moduleOrigin: BackendModuleOrigin): ParserSymbolOrigin {
  return {
    identity: { name, namespaces: ["React"] },
    moduleOrigin,
  };
}

describe("parser React identity policy", () => {
  it.each([
    "FC",
    "FunctionComponent",
    "ForwardRefExoticComponent",
    "MemoExoticComponent",
    "NamedExoticComponent",
  ])("does not trust the React wrapper name from a non-React dependency (%s)", (name) => {
    expect(
      isReactWrapperType(
        symbolOrigin(name, {
          moduleSpecifier: "not-react",
          packageName: "not-react",
          external: true,
        })
      )
    ).toBe(false);
  });

  it("accepts a canonical React wrapper origin", () => {
    expect(
      isReactWrapperType(
        symbolOrigin("FC", {
          moduleSpecifier: "react",
          packageName: "react",
          external: true,
        })
      )
    ).toBe(true);
  });

  it("keeps non-React dependency lookalike types opaque when external expansion is disabled", async () => {
    const result = await extractLookalikes();
    expect(result.module.imports).toEqual(["non-react-lookalikes"]);
    expect(result.warnings).toEqual([]);

    for (const [exportName, typeName] of lookalikeTypes) {
      const entry = exportEntry(result, exportName);
      if (entry.type.kind !== "external") throw new Error(`${exportName} was expanded`);
      expect(entry.type.typeName).toEqual({ name: typeName, namespaces: ["React"] });
      expect(entry.reexportedFrom).toBe(typeName);
      expect(entry.type.kind).not.toBe("component");
      expectDependencyProvenance(result, [exportName]);
    }

    for (const [exportName, typeName] of lookalikeCalls) {
      const entry = exportEntry(result, exportName);
      if (entry.type.kind !== "external") throw new Error(`${exportName} was expanded`);
      expect(entry.type.typeName).toEqual({ name: typeName, namespaces: ["React"] });
      expect(entry.type.kind).not.toBe("component");
      expectInputProvenance(result, [exportName]);
      expect(result.provenance.filter((candidate) => candidate.path[0] === exportName)).toHaveLength(1);
    }
  });

  it("expands non-React dependency lookalikes while keeping public call props", async () => {
    const result = await extractLookalikes({ includeExternalTypes: true });
    expect(result.warnings).toEqual([]);

    for (const [exportName, typeName] of lookalikeTypes) {
      const entry = exportEntry(result, exportName);
      expect(entry.type.kind).toBe("function");
      expect(entry.type.kind).not.toBe("component");
      expect(entry.type).toMatchObject({ typeName: { name: typeName, namespaces: ["React"] } });
      const props = functionProps(entry.type);
      expect(props).toMatchObject({
        kind: "object",
        properties: [{ name: "declared", type: { kind: "intrinsic", intrinsic: "string" } }],
      });
      if (props.kind !== "object") throw new Error("expected an object props type");
      expect(props.properties.some((property) => property.name === "callbackOnly")).toBe(false);
      expectDependencyProvenance(result, [exportName, "callSignatures", "0", "parameters", "props"]);
    }

    for (const [exportName, typeName] of lookalikeCalls) {
      const entry = exportEntry(result, exportName);
      // Mutation-sensitive public contract: these four dependency-owned
      // wrapper calls resolve to components from their public callable return
      // types and the declared dependency props. If wrapper identity regresses
      // to a name-only `isReactWrapperCall`, authored callback recovery would
      // replace `declared` with `callbackOnly`; these model/provenance checks
      // would then fail without inspecting that internal predicate.
      expect(entry.type).toMatchObject({
        kind: "component",
        typeName: { name: typeName, namespaces: ["React"] },
        props: [{ name: "declared", type: { kind: "intrinsic", intrinsic: "string" } }],
      });
      if (entry.type.kind !== "component") throw new Error("expected a component type");
      expect(entry.type.props).toHaveLength(1);
      expect(entry.type.props.some((property) => property.name === "callbackOnly")).toBe(false);
      expectInputProvenance(result, [exportName]);
      expectDependencyProvenance(result, [exportName, "props", "declared"]);
    }

    expect(result.provenance.filter((entry) => entry.path.includes("callbackOnly"))).toHaveLength(0);
  });

  it("does not rename a non-React `bivarianceHack` callback to React.RefCallback", async () => {
    // React declares `RefCallback<T>` as an indexed access into a
    // `{ bivarianceHack(instance): void }` literal, so the checker names the
    // callback after the method. Only React's own declaration earns the rename.
    // The alias is dropped only once `undefined` joins the union, so the
    // optional prop is where the method-named callback surfaces as a member.
    const result = await extractLookalikes();
    expect(result.warnings).toEqual([]);
    const entry = exportEntry(result, "LookalikeRefProps");
    if (entry.type.kind !== "object") throw new Error(`expected an object, got ${entry.type.kind}`);
    const ref = entry.type.properties.find((property) => property.name === "optionalRef")?.type;
    if (ref?.kind !== "union") throw new Error(`expected a union, got ${ref?.kind}`);
    const names = ref.types.map((member) =>
      member.kind === "external"
        ? { name: member.typeName.name, namespaces: member.typeName.namespaces }
        : member.kind
    );
    expect(names).toContainEqual({ name: "bivarianceHack", namespaces: undefined });
    expect(names).not.toContainEqual({ name: "RefCallback", namespaces: ["React"] });
  });
});
