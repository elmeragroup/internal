import { Schema } from "effect";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { readFixtureOracle } from "../scripts/fixture-evidence.ts";
import type { ExtractionResult } from "../src/index.ts";
import { warningMessage } from "../src/parse/fallback.ts";
import { ExtractWarningSchema } from "../src/warnings.ts";
import { extractFixture, fixtureRoot } from "./support/extract.ts";

const tsconfigPath = resolve(fixtureRoot, "react-recognition-tsconfig.json");

describe("basic component representation", () => {
  it("reports components with only the upstream-compatible shape and squashed props", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "react-component-function-declaration", "input.tsx")
    );
    const declared = result.module.exports.find((entry) => entry.name === "DeclaredComponent");
    expect(declared?.type).toEqual({
      kind: "component",
      typeName: { name: "DeclaredComponent" },
      props: [
        {
          name: "className",
          type: {
            kind: "union",
            types: [
              { kind: "intrinsic", intrinsic: "string" },
              { kind: "intrinsic", intrinsic: "undefined" },
            ],
          },
          optional: true,
        },
      ],
    });
  });

  it("keeps FC-annotated variables as named components through their callable surface", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "react-component-function-variable", "input.tsx")
    );
    for (const [exportName, typeName] of [
      ["TestComponent1", "TestComponent"],
      ["TestComponent2", "FC"],
      ["TestComponent3", "FunctionComponent"],
    ] as const) {
      const entry = result.module.exports.find((candidate) => candidate.name === exportName);
      expect(entry?.type).toMatchObject({ kind: "component", typeName: { name: typeName } });
    }
  });

  it("squashes the props of every overload into one table exactly as upstream", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "react-component-function-overloads", "input.ts")
    );
    const overloaded = result.module.exports.find((entry) => entry.name === "OverloadedComponent");
    if (overloaded?.type.kind !== "component") throw new Error("the overload squash disappeared");
    expect(overloaded.type.props.map((prop) => prop.name)).toEqual([
      "discriminant",
      "variant1Prop",
      "variant1OptionalProp",
      "mandatoryProp",
      "variant2Prop",
      "variant2OptionalProp",
    ]);
    // A prop required by one form and absent from the other becomes optional…
    const discriminant = overloaded.type.props.find((prop) => prop.name === "discriminant");
    expect(discriminant?.optional).toBe(true);
    // …while a prop both forms require stays required.
    const mandatory = overloaded.type.props.find((prop) => prop.name === "mandatoryProp");
    expect(mandatory?.optional).toBe(false);
  });
});

const reviewTsconfigPath = resolve(fixtureRoot, "react-recognition-boundary", "tsconfig.json");

async function extractReviewModule() {
  return extractFixture(
    { tsconfigPath: reviewTsconfigPath },
    resolve(fixtureRoot, "react-recognition-boundary", "input.tsx")
  );
}

function exportType(module: Awaited<ReturnType<typeof extractReviewModule>>["module"], name: string) {
  const entry = module.exports.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`missing export ${name}`);
  return entry.type;
}

describe("component recognition boundaries", () => {
  it("keeps a union with a non-component arm a union and reports structured uncertainty instead", async () => {
    const result = await extractReviewModule();
    // The semantic kind is deliberately unchanged: `Badge | undefined` is not
    // silently reshaped into one component.
    expect(exportType(result.module, "MaybeBadge").kind).toBe("union");
    if (result.warnings.length !== 1 || result.warnings[0]?.code !== "uncertain-component-recognition") {
      throw new Error("the mixed union did not report exactly one structured uncertainty");
    }
    const uncertain = result.warnings[0];
    expect(uncertain).toMatchObject({
      code: "uncertain-component-recognition",
      reason: "mixed-component-union",
      name: "MaybeBadge",
      line: 28,
    });
    expect(() => Schema.decodeUnknownSync(ExtractWarningSchema)(uncertain)).not.toThrow();
    const rendered = warningMessage(uncertain);
    expect(rendered.message).toContain('Could not classify "MaybeBadge" as a React component');
    expect(rendered.message).toContain("Review the export if it should be a component");
    expect(result.warnings).toHaveLength(1);
  });

  it("still merges unions whose every arm is a component into one prop table", async () => {
    const result = await extractReviewModule();
    const variant = exportType(result.module, "VariantBadge");
    if (variant.kind !== "component") throw new Error("the all-component union lost its transform");
    // Each prop is optional because some arm of the merged component rejects it.
    expect(variant.props.map((prop) => [prop.name, prop.optional])).toEqual([
      ["label", true],
      ["onSelect", true],
      ["count", true],
    ]);
    // No arm carries its own name, so the merged component stays anonymous.
    expect(variant.typeName).toBeUndefined();
  });

  it("names an aliased union's component after the alias, as upstream does", async () => {
    const result = await extractReviewModule();
    const aliased = exportType(result.module, "AliasedVariant");
    expect(aliased).toMatchObject({ kind: "component", typeName: { name: "VariantAlias" } });
  });

  it("makes props optional through a signature that takes no props at all", async () => {
    const result = await extractReviewModule();
    const overloaded = exportType(result.module, "OverloadedBadge");
    if (overloaded.kind !== "component") throw new Error("the zero-prop overload lost its transform");
    // Read from the resolved call signatures when no declaration initializer
    // exists; the empty-parameter signature forces optionality on both forms.
    expect(overloaded.props.map((prop) => [prop.name, prop.optional])).toEqual([
      ["label", true],
      ["onSelect", true],
    ]);
  });

  it("keeps a union arm's intersection whole when squashing props, as upstream does", async () => {
    const result = await extractReviewModule();
    const badge = exportType(result.module, "IntersectionUnionBadge");
    if (badge.kind !== "component") throw new Error("the intersection-union lost its transform");
    // `(SquashLeft & SquashRight) | SquashPlain` contributes its whole
    // intersection as ONE used-set, so both props stay required: every squash
    // entry uses them. Flattening the arm into per-object sets would invent a
    // `{left}`-only set and mark both props optional.
    expect(badge.props.map((prop) => [prop.name, prop.optional])).toEqual([
      ["left", false],
      ["right", false],
    ]);
  });

  it("recognizes a bare arrow-function component and extracts its props", async () => {
    const result = await extractReviewModule();
    const arrow = exportType(result.module, "ArrowBadge");
    if (arrow.kind !== "component") throw new Error("the bare arrow was not recognized");
    expect(arrow.props.map((prop) => [prop.name, prop.optional])).toEqual([["title", false]]);
  });

  it("recognizes a React.FC-annotated arrow variable and extracts its props", async () => {
    const result = await extractReviewModule();
    const annotated = exportType(result.module, "FcBadge");
    expect(annotated).toMatchObject({
      kind: "component",
      typeName: { name: "FC", namespaces: ["React"] },
    });
    if (annotated.kind !== "component") throw new Error("unreachable");
    expect(annotated.props.map((prop) => [prop.name, prop.optional])).toEqual([["count", false]]);
  });

  it("extracts a children prop like any other optional prop", async () => {
    const result = await extractReviewModule();
    const slot = exportType(result.module, "ChildrenSlot");
    if (slot.kind !== "component") throw new Error("ChildrenSlot lost its transform");
    const children = slot.props.find((prop) => prop.name === "children");
    if (children === undefined) throw new Error("the children prop did not land in the table");
    expect(children.optional).toBe(true);
    expect(children.type).toMatchObject({
      kind: "union",
      types: [
        { kind: "intrinsic", intrinsic: "string" },
        { kind: "intrinsic", intrinsic: "number" },
        { kind: "intrinsic", intrinsic: "undefined" },
      ],
    });
  });

  it("never transforms lowercase exports however React-like their returns", async () => {
    const result = await extractReviewModule();
    const hook = exportType(result.module, "useBadgeValue");
    expect(hook.kind).toBe("function");
    if (hook.kind !== "function") throw new Error("unreachable");
    // The callable surface survives untouched on declined candidates. The
    // ReactNode return summarizes as the opaque external reference the
    // external-before-callable ordering produces (Issue 13) — recognition
    // policy reads resolved functions, and a summarized return is not one.
    const [signature] = hook.callSignatures;
    if (signature === undefined) throw new Error("the hook lost its call signature");
    expect(signature.returnValueType).toMatchObject({
      kind: "external",
      typeName: { name: "ReactNode" },
    });
  });

  it("classifies lookalike return types as ordinary functions with their callable surface intact", async () => {
    const tsconfig = resolve(fixtureRoot, "react-recognition-tsconfig.json");
    const result = await extractFixture(
      { tsconfigPath: tsconfig },
      resolve(fixtureRoot, "react-component-return-types", "input.tsx")
    );
    expect(result.module).toEqual(readFixtureOracle("react-component-return-types", "output.json"));
    for (const lookalike of ["LocalElementType", "DomElementType"]) {
      const entry = result.module.exports.find((candidate) => candidate.name === lookalike);
      expect(entry?.type.kind).toBe("function");
      if (entry?.type.kind !== "function") throw new Error("unreachable");
      expect(entry.type.callSignatures.length).toBeGreaterThan(0);
    }
  });
});

describe("object-of-components module values", () => {
  const componentObjectTsconfig = resolve(fixtureRoot, "component-object", "tsconfig.json");

  async function extractComponentObject(): Promise<ExtractionResult> {
    return extractFixture(
      { tsconfigPath: componentObjectTsconfig },
      resolve(fixtureRoot, "component-object", "input.tsx")
    );
  }

  it("describes a module value whose every member is a component as an object of components", async () => {
    const result = await extractComponentObject();
    const menu = result.module.exports.find((entry) => entry.name === "Menu");
    if (menu?.type.kind !== "object")
      throw new Error(`Menu is ${menu?.type.kind ?? "missing"}, not an object`);
    expect(menu.type.properties.map((property) => property.name)).toEqual(["Root", "Item"]);
    const [root, item] = menu.type.properties;
    expect(root?.type).toMatchObject({
      kind: "component",
      typeName: { name: "MenuRoot" },
      props: [
        { name: "open", optional: true },
        { name: "children", optional: true },
      ],
    });
    expect(item?.type).toMatchObject({
      kind: "component",
      typeName: { name: "MenuItem" },
      props: [
        { name: "value", optional: false, type: { kind: "intrinsic", intrinsic: "string" } },
        { name: "disabled", optional: true },
      ],
    });
    expect(root?.type.kind === "component" ? root.type.props[0]?.documentation : undefined).toMatchObject({
      description: "Whether the menu starts open.",
    });
    expect(result.warnings.filter((warning) => warning.parsedSymbolStack.includes("Menu"))).toEqual([]);
  });

  it("records provenance for the members and their props", async () => {
    const result = await extractComponentObject();
    const paths = result.provenance.map((entry) => entry.path.join("/"));
    expect(paths).toContain("Menu/properties/Root");
    expect(paths).toContain("Menu/properties/Item");
    expect(paths).toContain("Menu/properties/Item/props/value");
    const disabled = result.provenance.find(
      (entry) => entry.path.join("/") === "Menu/properties/Item/props/disabled"
    );
    expect(disabled?.defaultInitializer).toBe("false");
  });

  it("keeps the upstream fallback for a module value that is not only components", async () => {
    const result = await extractComponentObject();
    const mixed = result.module.exports.find((entry) => entry.name === "mixed");
    expect(mixed?.type).toEqual({ kind: "intrinsic", intrinsic: "any" });
    expect(result.warnings.map((warning) => warning.code)).toEqual(["unsupported-type-fallback"]);
  });
});
