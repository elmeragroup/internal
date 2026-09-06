import { Schema } from "effect";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  expectedFixtureWarnings,
  expectedWarningCodes,
  normalizeWarnings,
} from "../scripts/fixture-evidence.ts";
import type { ExtractionResult } from "../src/index.ts";
import type { ComponentNode, SemanticType } from "../src/model.ts";
import { ProvenanceEntrySchema } from "../src/provenance.ts";
import { ExtractWarningSchema } from "../src/warnings.ts";
import { extractFixture, fixtureRoot } from "./support/extract.ts";
import { reactFixtureAudit, reactWrapperFixtures } from "./support/fixture-suites.ts";

const tsconfigPath = resolve(fixtureRoot, "react-origin-tsconfig.json");

function readJson(fixture: string, file: string): Schema.Json {
  return Schema.decodeUnknownSync(Schema.Json)(
    JSON.parse(readFileSync(resolve(fixtureRoot, fixture, file), "utf8"))
  );
}

function component(result: ExtractionResult, name: string): ComponentNode {
  const entry = result.module.exports.find((candidate) => candidate.name === name);
  if (entry?.type.kind !== "component") throw new Error(`Expected component export ${name}`);
  return entry.type;
}

function property(type: ComponentNode, name: string): SemanticType {
  const entry = type.props.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`Expected component prop ${name}`);
  return entry.type;
}

describe("wrapped React component warnings and fixture audit", () => {
  it("matches the structured warning oracle for every wrapper", async () => {
    for (const definition of reactWrapperFixtures) {
      const result = await extractFixture(
        { tsconfigPath },
        resolve(fixtureRoot, definition.fixture, definition.file)
      );
      const expected = Schema.decodeUnknownSync(Schema.Array(ExtractWarningSchema))(
        readJson(definition.fixture, "warnings.tsgo.json")
      );
      expect(normalizeWarnings(result.warnings)).toEqual(expected);
      expect(result.warnings.map((warning) => warning.code)).toEqual(
        expectedWarningCodes(expectedFixtureWarnings, definition.fixture)
      );
      for (const provenance of result.provenance) {
        expect(() => Schema.decodeUnknownSync(ProvenanceEntrySchema)(provenance)).not.toThrow();
      }
    }
  });

  it("audits all 22 upstream React fixtures plus the Base UI compound boundary", () => {
    const names = reactFixtureAudit.map((entry) => entry.fixture);
    expect(new Set(names).size).toBe(23);
    expect(names).toEqual([
      "react-component-function-declaration",
      "react-component-function-variable",
      "react-component-return-types",
      "react-component-function-overloads",
      "react-component-generic-function-overloads",
      "react-component-overload-any-callback-deduplication",
      "react-component-render-callback-props",
      "react-component-union-variants",
      "react-event-handlers",
      "react-hook-arrow-function",
      "react-hook-function-declaration",
      "react-hook-function-expression",
      "react-hook-multiple-parameters",
      "react-hook-overload-signatures",
      "react-props-callback-types",
      "react-props-literal-types",
      "react-props-optional-types",
      "react-refs",
      "react-forward-ref-component",
      "react-forward-ref-union-props",
      "react-memo-component",
      "react-mui-overridable-component",
      "base-ui-component",
    ]);
    expect(
      reactFixtureAudit.filter((entry) => entry.owner === "issue12").map((entry) => entry.fixture)
    ).toEqual([
      "react-forward-ref-component",
      "react-forward-ref-union-props",
      "react-memo-component",
      "react-mui-overridable-component",
      "base-ui-component",
    ]);
    expect(reactWrapperFixtures.map((entry) => entry.fixture)).toEqual([
      "react-forward-ref-component",
      "react-forward-ref-union-props",
      "react-memo-component",
      "react-mui-overridable-component",
    ]);
  });
});

describe("wrapped and compound component representation", () => {
  it("preserves forwardRef props, ref type, docs, and authored ownership", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "react-forward-ref-component", "input.tsx")
    );
    const type = component(result, "TestComponent");
    expect(type.typeName).toMatchObject({
      name: "ForwardRefExoticComponent",
      namespaces: ["React"],
    });
    expect(type.props.map((entry) => entry.name)).toEqual(["className", "id"]);
    expect(
      result.module.exports.find((entry) => entry.name === "TestComponent")?.documentation
    ).toMatchObject({
      description: "A test component",
    });
    const argument = type.typeName?.typeArguments?.[0]?.type;
    if (argument?.kind !== "intersection") throw new Error("forwardRef props lost its intersection");
    expect(
      argument.types.some(
        (member) =>
          member.kind === "external" &&
          member.typeName.name === "RefAttributes" &&
          member.typeName.namespaces?.join(".") === "React"
      )
    ).toBe(true);
    expect(result.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["TestComponent", "props", "className"] }),
        expect.objectContaining({ path: ["TestComponent", "props", "id"] }),
      ])
    );
    const propProvenance = result.provenance.filter(
      (entry) => entry.path[0] === "TestComponent" && entry.path[1] === "props"
    );
    expect(propProvenance.length).toBeGreaterThan(0);
    expect(
      propProvenance.every((entry) =>
        entry.declarations
          .map((declaration) => declaration.path)
          .every((path) => !path.includes("node_modules"))
      )
    ).toBe(true);
  });

  it("preserves memo props and display documentation", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "react-memo-component", "input.tsx")
    );
    const type = component(result, "TestComponent");
    expect(type.typeName).toMatchObject({ name: "NamedExoticComponent", namespaces: ["React"] });
    expect(type.props.map((entry) => entry.name)).toEqual(["className", "id"]);
    expect(
      result.module.exports.find((entry) => entry.name === "TestComponent")?.documentation
    ).toMatchObject({
      description: "A test component",
    });
  });

  it("squashes forwardRef union props while retaining each ref arm", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "react-forward-ref-union-props", "input.tsx")
    );
    const type = component(result, "Button");
    expect(type.typeName).toMatchObject({
      name: "ForwardRefExoticComponent",
      namespaces: ["React"],
    });
    expect(type.props.map((entry) => entry.name)).toEqual(["type", "id", "className", "nativeButton"]);
    const nativeButton = property(type, "nativeButton");
    if (nativeButton.kind !== "union") throw new Error("nativeButton lost its union type");
    expect(nativeButton.types).toEqual([
      { kind: "intrinsic", intrinsic: "boolean" },
      { kind: "intrinsic", intrinsic: "undefined" },
    ]);
    const argument = type.typeName?.typeArguments?.[0]?.type;
    if (argument?.kind !== "union") throw new Error("forwardRef union props lost its union");
    const refArms = argument.types.filter(
      (member) =>
        member.kind === "intersection" &&
        member.types.some(
          (child) =>
            child.kind === "external" &&
            child.typeName.name === "RefAttributes" &&
            child.typeName.namespaces?.join(".") === "React"
        )
    );
    expect(refArms).toHaveLength(2);
  });

  it("resolves MUI overridable props as one established component model", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "react-mui-overridable-component", "input.d.ts")
    );
    const type = component(result, "default");
    expect(type.typeName).toBeUndefined();
    expect(type.props.map((entry) => entry.name)).toEqual(["component", "variant", "className", "style"]);
    const componentProp = property(type, "component");
    if (componentProp.kind !== "union") throw new Error("overridable component prop lost its overload union");
    const root = componentProp.types.find((member) => member.kind === "typeParameter");
    expect(root).toMatchObject({
      kind: "typeParameter",
      name: "RootComponent",
      constraint: {
        kind: "external",
        typeName: { name: "ElementType", namespaces: ["React"] },
      },
    });
    expect(property(type, "variant")).toMatchObject({ kind: "union" });
    expect(property(type, "style")).toMatchObject({ kind: "union" });
    expect(result.warnings.every((warning) => warning.code === "omitted-index-signature")).toBe(true);
  });

  it("supports nested wrappers and namespace compound members at the public seam", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "react-wrapper-provenance", "input.tsx")
    );
    const nested = component(result, "NestedWrapped");
    expect(nested.typeName).toMatchObject({ name: "NamedExoticComponent", namespaces: ["React"] });
    expect(nested.props.map((entry) => entry.name)).toEqual(["label", "children"]);
    expect(result.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["NestedWrapped", "props", "label"] }),
        expect.objectContaining({ path: ["NestedWrapped", "props", "children"] }),
      ])
    );
    expect(component(result, "CompoundRoot.Item")).toMatchObject({
      kind: "component",
      typeName: { name: "Item", namespaces: ["CompoundRoot"] },
    });
    expect(result.module.exports.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["CompoundRoot", "CompoundRoot.Item", "CompoundRoot.Props"])
    );
    expect(component(result, "default")).toMatchObject({
      kind: "component",
      typeName: { name: "ForwardRefExoticComponent", namespaces: ["React"] },
      props: [{ name: "label", optional: false }],
    });
    expect(component(result, "GenericWrapped")).toMatchObject({
      kind: "component",
      typeName: { name: "MemoExoticComponent", namespaces: ["React"] },
      props: [
        {
          name: "value",
          type: { kind: "typeParameter", name: "Value" },
          optional: false,
        },
      ],
    });
    expect(component(result, "OverloadedWrapped")).toMatchObject({
      kind: "component",
      typeName: { name: "MemoExoticComponent", namespaces: ["React"] },
      props: [
        { name: "text", type: { kind: "union" }, optional: true },
        { name: "count", type: { kind: "union" }, optional: true },
      ],
    });
    expect(result.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["GenericWrapped", "props", "value"] }),
        expect.objectContaining({ path: ["OverloadedWrapped", "props", "text"] }),
        expect.objectContaining({ path: ["OverloadedWrapped", "props", "count"] }),
      ])
    );
  });

  it("follows only React wrappers and never imports arbitrary callback or comparator props", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "react-wrapper-provenance", "input.tsx")
    );

    expect(component(result, "ArbitraryWrapped").props.map((entry) => entry.name)).toEqual(["resolvedOnly"]);
    expect(component(result, "ArbitraryWrapped").props.map((entry) => entry.name)).not.toContain(
      "callbackOnly"
    );
    expect(
      result.provenance.some(
        (entry) => entry.path.includes("callbackOnly") || entry.path.includes("ArbitraryCallbackProps")
      )
    ).toBe(false);
    expect(component(result, "AliasWrapped").props.map((entry) => entry.name)).toEqual(["value"]);
    expect(component(result, "ComparedWrapped").props.map((entry) => entry.name)).toEqual(["value"]);
    expect(component(result, "ComparedWrapped").props.map((entry) => entry.name)).not.toContain(
      "comparatorOnly"
    );
  });

  it("derives overloaded wrapper props from public signatures only", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "react-wrapper-provenance", "input.tsx")
    );

    expect(component(result, "ImplementationLeakWrapped").props.map((entry) => entry.name)).toEqual([
      "text",
      "count",
    ]);
    expect(component(result, "ImplementationLeakWrapped").props.map((entry) => entry.name)).not.toContain(
      "implementationOnly"
    );

    const generic = component(result, "GenericImplementationLeakWrapped");
    expect(generic.props.map((entry) => entry.name)).toEqual(["value", "count"]);
    expect(generic.props.map((entry) => entry.name)).not.toContain("implementationOnly");
    const value = property(generic, "value");
    if (value.kind !== "union") throw new Error("generic overload prop lost its optional union");
    expect(value.types).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "typeParameter", name: "Value" })])
    );
  });

  it("keeps a forwardRef wrapper recognizable when external expansion is enabled", async () => {
    const forward = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "react-forward-ref-component", "input.tsx"),
      {
        includeExternalTypes: true,
      }
    );
    expect(component(forward, "TestComponent").props.map((entry) => entry.name)).toEqual(["className", "id"]);
  }, 60_000);

  it("keeps a memo wrapper recognizable when external expansion is enabled", async () => {
    const memo = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "react-memo-component", "input.tsx"),
      {
        includeExternalTypes: true,
      }
    );
    expect(memo.module.exports.find((entry) => entry.name === "TestComponent")?.type.kind).toBe("component");
  });
});
