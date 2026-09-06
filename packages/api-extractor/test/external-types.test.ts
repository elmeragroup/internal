import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { expectedFixtureWarnings, expectedWarningCodes } from "../scripts/fixture-evidence.ts";
import type { ExtractionResult } from "../src/index.ts";
import type { ExternalTypeNode } from "../src/model.ts";
import { defaultExtractorOptions } from "../src/options.ts";
import { extractFixture, fixtureRoot } from "./support/extract.ts";
import { externalTypeFixtures } from "./support/fixture-suites.ts";

const tsconfigPath = resolve(fixtureRoot, "external-types-tsconfig.json");

describe("external-type warnings on the ported upstream fixtures", () => {
  it("emits exactly the warnings each reviewed record declares", async () => {
    for (const definition of externalTypeFixtures) {
      const result = await extractFixture(
        { tsconfigPath },
        resolve(fixtureRoot, definition.fixture, definition.file)
      );
      const expectedCodes = [...expectedWarningCodes(expectedFixtureWarnings, definition.fixture)].sort();
      const actualCodes = result.warnings.map((warning) => warning.code).sort();
      expect(actualCodes).toEqual(expectedCodes);
    }
  });

  it("keeps the implementation contribution for a direct overloaded component export", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "react-component-overload-any-callback-deduplication", "input.tsx")
    );
    const entry = result.module.exports.find((candidate) => candidate.name === "GenericComponent");
    if (entry?.type.kind !== "component") throw new Error("Expected GenericComponent component export");
    const items = entry.type.props.find((property) => property.name === "items")?.type;
    if (items?.kind !== "union") throw new Error("Expected overloaded items prop union");
    const itemValueArrays = items.types.filter(
      (member) =>
        member.kind === "array" &&
        member.elementType.kind === "typeParameter" &&
        member.elementType.name === "ItemValue"
    );
    // Direct exported functions intentionally retain the authored
    // implementation contribution; wrapper identifiers use public signatures.
    expect(itemValueArrays).toHaveLength(2);
  });
});

describe("external-type ownership policy in both modes", () => {
  it("keeps project-owned TypeScript-shaped declarations project-owned", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "external-root-boundary", "input.ts")
    );
    const exports = new Map(result.module.exports.map((entry) => [entry.name, entry]));
    expect(exports.get("ProjectArray")?.type).toMatchObject({
      kind: "object",
      typeName: { name: "Array" },
      properties: [{ name: "baseMarker" }, { name: "projectMarker" }],
    });
    expect(exports.get("ProjectArray")?.documentation).toMatchObject({
      description: "The workspace-owned Array declaration is not TypeScript's built-in Array.",
    });
    expect(exports.get("ProjectArray")?.extendsTypes).toEqual([{ name: "ProjectArrayBase" }]);
    expect(exports.get("ProjectReadonlyArray")?.type).toMatchObject({
      kind: "object",
      typeName: { name: "ReadonlyArray" },
      properties: [{ name: "projectMarker" }],
    });
    expect(exports.get("ProjectArray")?.type.kind).not.toBe("array");
    expect(exports.get("ProjectReadonlyArray")?.type.kind).not.toBe("array");
    // A project-owned `Extract` in a compiler-looking path must not trigger
    // the built-in conditional gate: its authored identity remains visible.
    expect(exports.get("ProjectExtractUse")?.type).toEqual({
      kind: "union",
      typeName: { name: "ProjectExtractUse" },
      types: [
        { kind: "literal", value: '"other"' },
        { kind: "literal", value: '"value"' },
      ],
    });
    expect(result.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["ProjectArray"],
          declarations: [
            expect.objectContaining({
              path: "test/fixtures/external-root-boundary/src/typescript/lib/lib.dom.d.ts",
            }),
          ],
        }),
        expect.objectContaining({
          path: ["ProjectReadonlyArray"],
          declarations: [
            expect.objectContaining({
              path: "test/fixtures/external-root-boundary/src/@typescript/tsc/lib/lib.es2022.d.ts",
            }),
          ],
        }),
      ])
    );
  });

  it("does not apply an enclosing project namespace to a top-level concrete argument", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "external-root-boundary", "input.ts")
    );
    const entry = result.module.exports.find(
      (candidate) => candidate.name === "ProjectNamespaceSubstitution"
    );
    expect(entry?.type).toMatchObject({
      kind: "object",
      typeName: { name: "ProjectNamespaceSubstitution" },
      properties: [
        {
          name: "wrapped",
          type: {
            typeName: { name: "OuterAlias" },
            properties: [
              {
                name: "value",
                type: {
                  typeName: { name: "Local" },
                },
              },
            ],
          },
        },
      ],
    });
    const wrapped = entry?.type.kind === "object" ? entry.type.properties[0]?.type : undefined;
    if (wrapped?.kind !== "object") throw new Error("Expected the project generic object to resolve");
    const local = wrapped.properties.find((property) => property.name === "value")?.type;
    expect(local).toMatchObject({ kind: "object", typeName: { name: "Local" } });
    expect(local?.kind === "object" ? local.typeName?.namespaces : undefined).toBeUndefined();
  });

  it("preserves a project namespace through a local holder into an external ref argument", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "external-root-boundary", "input.ts")
    );
    const entry = result.module.exports.find(
      (candidate) => candidate.name === "ProjectNestedNamespaceSubstitution"
    );
    expect(entry?.type).toMatchObject({
      kind: "object",
      properties: [
        {
          name: "ref",
          type: {
            kind: "external",
            typeName: {
              name: "Ref",
              namespaces: ["React"],
              typeArguments: [
                {
                  type: {
                    kind: "object",
                    typeName: { name: "Local", namespaces: ["Outer"] },
                  },
                },
              ],
            },
          },
        },
      ],
    });
  });

  it("pins dependency-owned bare interface and value roots as anonymous empty objects", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "external-root-boundary", "input.ts")
    );
    const rootTypes = new Map(result.module.exports.map((entry) => [entry.name, entry.type]));

    expect(rootTypes.get("BareInterface")).toEqual({ kind: "object", properties: [] });
    expect(rootTypes.get("bareValue")).toEqual({ kind: "object", properties: [] });
    expect(
      result.module.exports.filter((entry) => entry.name === "BareInterface" || entry.name === "bareValue")
    ).toHaveLength(2);
    expect(result.provenance.some((entry) => entry.path[0] === "BareInterface")).toBe(false);
    expect(result.provenance.some((entry) => entry.path[0] === "bareValue")).toBe(false);
  });

  it("summarizes dependency-owned handlers as opaque references when expansion is disabled", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "react-event-handlers", "input.ts")
    );
    const component = result.module.exports.find((entry) => entry.name === "EventHandlersComponent");
    if (component?.type.kind !== "component") throw new Error("the component transform vanished");
    const onClick = component.type.props.find((prop) => prop.name === "onClick");
    if (onClick === undefined) throw new Error("the onClick prop disappeared");
    // The dependency-owned alias keeps its package identity, authored name,
    // and provenance through its type arguments.
    expect(onClick.type).toMatchObject({
      kind: "external",
      typeName: { name: "MouseEventHandler", namespaces: ["React"] },
    } satisfies Partial<ExternalTypeNode>); // SAFETY: the summarized node is an external reference by policy.
    const onFocus = component.type.props.find((prop) => prop.name === "onFocus");
    if (onFocus?.type.kind !== "external") throw new Error("onFocus did not summarize");
    expect(onFocus.type.typeName.typeArguments?.[0]?.type).toMatchObject({
      kind: "external",
      typeName: { name: "HTMLDivElement" },
    });
  });

  it("resolves dependency-owned properties without losing the library/dependency boundary when expansion is enabled", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "react-event-handlers", "input.ts"),
      {
        includeExternalTypes: true,
      }
    );
    const component = result.module.exports.find((entry) => entry.name === "EventHandlersComponent");
    if (component?.type.kind !== "component") throw new Error("the component transform vanished");
    const onKeyDown = component.type.props.find((prop) => prop.name === "onKeyDown");
    if (onKeyDown === undefined) throw new Error("the onKeyDown prop disappeared");
    // The optional handler resolves as `KeyboardEventHandler<Element> |
    // undefined`; its first arm is a real callable carrying the expanded
    // dependency-owned signature.
    if (onKeyDown.type.kind !== "union" || onKeyDown.type.types[0]?.kind !== "function") {
      throw new Error("the dependency-owned handler was not resolved in expansion mode");
    }
    const [signature] = onKeyDown.type.types[0].callSignatures;
    if (signature === undefined) throw new Error("the expanded handler lost its signature");
    // Its event parameter is the EXPANDED React.KeyboardEvent object, not an
    // opaque reference: expansion mode opens the dependency graph under the
    // same traversal limits upstream applies.
    const eventParameter = signature.parameters[0];
    expect(eventParameter?.type).toMatchObject({
      kind: "object",
      typeName: { name: "KeyboardEvent", namespaces: ["React"] },
    });
  });

  it("expands a standard-library-owned property surface only when the option asks for it", async () => {
    const disabled = await extractFixture({ tsconfigPath }, resolve(fixtureRoot, "react-refs", "input.tsx"));
    const enabled = await extractFixture({ tsconfigPath }, resolve(fixtureRoot, "react-refs", "input.tsx"), {
      includeExternalTypes: true,
    });
    const propOf = (result: ExtractionResult, name: string) => {
      const component = result.module.exports.find((entry) => entry.name === "RefPropsComponent");
      if (component?.type.kind !== "component") throw new Error("the component vanished");
      const prop = component.type.props.find((candidate) => candidate.name === name);
      if (prop === undefined) throw new Error(`the ${name} prop disappeared`);
      return prop.type;
    };
    // refObject names React.RefObject: dependency-owned, so it summarizes…
    expect(propOf(disabled, "refObject").kind).toBe("external");
    // …and expands under the option.
    expect(propOf(enabled, "refObject").kind).not.toBe("external");
  });

  it("mirrors upstream's traversal limits for dependency graphs", () => {
    const limit = defaultExtractorOptions.shouldResolveObject;
    // Upstream's default (`parserContextFactory.ts`): expand at property depth
    // zero or while at most fifty properties are involved, and never past ten
    // intermediate types — the cap that keeps enabled-mode dependency graphs
    // bounded regardless of `includeExternalTypes`.
    expect(limit({ name: "", propertyCount: 51, depth: 1, propertyDepth: 1 })).toBe(false);
    expect(limit({ name: "", propertyCount: 50, depth: 10, propertyDepth: 1 })).toBe(true);
    expect(limit({ name: "", propertyCount: 50, depth: 11, propertyDepth: 1 })).toBe(false);
    expect(limit({ name: "", propertyCount: 4, depth: 3, propertyDepth: 0 })).toBe(true);
  });
});

describe("summarized references keep durable identity", () => {
  it("never exposes compiler paths or handles in extracted output", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "react-event-handlers", "input.ts")
    );
    const serialized = JSON.stringify({ module: result.module, provenance: result.provenance });
    expect(serialized.includes("node_modules")).toBe(false);
    expect(serialized.includes("/lib/")).toBe(false);
    // Provenance paths are repository-relative; declaration paths of the
    // summarized externals stay out of the module graph entirely because the
    // reference carries names and arguments, not declarations.
    for (const warning of result.warnings) {
      expect(warning.message.includes("node_modules")).toBe(false);
    }
  });

  it("reports an unresolved dependency alias through the structured fallback contract", async () => {
    // The flattened Prettify member in this fixture has no representable
    // dependency-owned identity on TypeScript 7's checker view; it degrades to
    // `any` behind the structured warning instead of disappearing silently.
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "external-union-type-name-preservation", "input.ts")
    );
    const fallbacks = result.warnings.filter((warning) => warning.code === "unsupported-type-fallback");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]?.message).toContain("The extractor used any");
    expect(fallbacks[0]?.message).toContain("Review this API or add support for this type");
  });
});
