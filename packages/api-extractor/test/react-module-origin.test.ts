import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { ExtractionResult } from "../src/index.ts";
import type { ComponentNode } from "../src/model.ts";
import { extractFixture } from "./support/extract.ts";

const fixtureRoot = resolve(import.meta.dirname, "fixtures/react-module-origin-forms");
const inputPath = resolve(fixtureRoot, "input.tsx");
const tsconfigPath = resolve(fixtureRoot, "tsconfig.json");
const importEqualsFixtureRoot = resolve(fixtureRoot, "import-equals");
const importEqualsInputPath = resolve(importEqualsFixtureRoot, "input.tsx");
const importEqualsTsconfigPath = resolve(importEqualsFixtureRoot, "tsconfig.json");
const ambiguousFixtureRoot = resolve(fixtureRoot, "ambiguous-star");
const ambiguousInputPath = resolve(ambiguousFixtureRoot, "input.tsx");
const ambiguousBarrelPath = resolve(ambiguousFixtureRoot, "barrel.ts");
const ambiguousTsconfigPath = resolve(ambiguousFixtureRoot, "tsconfig.json");
const angleAssertionFixtureRoot = resolve(fixtureRoot, "angle-assertion");
const angleAssertionInputPath = resolve(angleAssertionFixtureRoot, "input.ts");
const angleAssertionTsconfigPath = resolve(angleAssertionFixtureRoot, "tsconfig.json");
const sameOriginStarFixtureRoot = resolve(fixtureRoot, "same-origin-star");
const sameOriginStarInputPath = resolve(sameOriginStarFixtureRoot, "input.tsx");
const sameOriginStarBarrelPath = resolve(sameOriginStarFixtureRoot, "barrel.ts");
const sameOriginStarTsconfigPath = resolve(sameOriginStarFixtureRoot, "tsconfig.json");

function component(result: ExtractionResult, name: string): ComponentNode {
  const entry = result.module.exports.find((candidate) => candidate.name === name);
  if (entry?.type.kind !== "component") throw new Error(`Expected component export ${name}`);
  return entry.type;
}

describe("Issue 12 React module-origin regressions", () => {
  it("rejects local React lookalikes without losing the resolved public props", async () => {
    const result = await extractFixture({ tsconfigPath }, inputPath);

    expect(component(result, "FakeModule").props.map((entry) => entry.name)).toEqual(["resolvedOnly"]);
    expect(component(result, "ShadowedNamespace").props.map((entry) => entry.name)).toEqual(["resolvedOnly"]);
    expect(
      result.provenance.some(
        (entry) => entry.path.includes("callbackOnly") || entry.path.includes("CallbackProps")
      )
    ).toBe(false);
  });

  it("follows a multi-hop re-export back to the public React module", async () => {
    const result = await extractFixture({ tsconfigPath }, inputPath);

    expect(component(result, "Bridged").props.map((entry) => entry.name)).toEqual(["bridgedOnly"]);
    expect(component(result, "StarBridged").props.map((entry) => entry.name)).toEqual(["starOnly"]);
    expect(component(result, "NamespaceBridged").props.map((entry) => entry.name)).toEqual(["namespaceOnly"]);
    expect(result.provenance).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ["Bridged", "props", "bridgedOnly"] })])
    );
  });

  it("supports import-equals bindings against export = React and keeps every overload", async () => {
    const result = await extractFixture({ tsconfigPath: importEqualsTsconfigPath }, importEqualsInputPath);

    expect(component(result, "ImportEqualsWrapped").props.map((entry) => entry.name)).toEqual(["a", "b"]);
    expect(component(result, "ExportEqualsBridgeWrapped").props.map((entry) => entry.name)).toEqual([
      "a",
      "b",
    ]);
    expect(component(result, "NamedImportEqualsWrapped").props.map((entry) => entry.name)).toEqual([
      "a",
      "b",
    ]);
  });

  it("resolves complete nested namespace paths through export-star-as", async () => {
    const result = await extractFixture({ tsconfigPath }, inputPath);

    expect(component(result, "NestedBridgeWrapped").props.map((entry) => entry.name)).toEqual(["a", "b"]);
  });

  it("unwraps angle-bracket assertions in .ts module-origin expressions", async () => {
    const result = await extractFixture(
      { tsconfigPath: angleAssertionTsconfigPath },
      angleAssertionInputPath
    );

    expect(component(result, "AngleAssertionWrapped").props.map((entry) => entry.name)).toEqual(["a", "b"]);
  });

  it("follows local initializer and exported React aliases without accepting lookalikes", async () => {
    const result = await extractFixture({ tsconfigPath }, inputPath);

    expect(component(result, "LocalAliasWrapped").props.map((entry) => entry.name)).toEqual(["a", "b"]);
    expect(component(result, "ElementAccessWrapped").props.map((entry) => entry.name)).toEqual(["a", "b"]);
    // A computed key has no statically recoverable callee symbol, so the
    // resolver keeps the checker-selected final overload only.
    expect(component(result, "DynamicElementAccessWrapped").props.map((entry) => entry.name)).toEqual(["b"]);
    expect(component(result, "ExportedAliasWrapped").props.map((entry) => entry.name)).toEqual(["a", "b"]);
    expect(component(result, "FakeModule").props.map((entry) => entry.name)).toEqual(["resolvedOnly"]);
    expect(component(result, "ShadowedNamespace").props.map((entry) => entry.name)).toEqual(["resolvedOnly"]);
  });

  it("does not select a React origin from an ambiguous star barrel", async () => {
    // The fixture deliberately suppresses TS2308 at its conflicting star so
    // this invalid-input disposition stays typechecked and reviewable.
    const result = await extractFixture({ tsconfigPath: ambiguousTsconfigPath }, ambiguousInputPath);
    expect(component(result, "AmbiguousWrapped").props.map((entry) => entry.name)).toEqual(["b"]);
    expect(component(result, "TransitiveAmbiguousWrapped").props.map((entry) => entry.name)).toEqual(["b"]);
  });

  it("keeps distinct star origins ambiguous", async () => {
    const result = await extractFixture({ tsconfigPath: ambiguousTsconfigPath }, ambiguousBarrelPath);

    expect(
      result.warnings.some(
        (warning) => warning.code === "unresolved-re-export" && warning.reason === "ambiguous"
      )
    ).toBe(true);
  });

  it("accepts diagnostic-free stars that resolve to the same ultimate symbol", async () => {
    const result = await extractFixture(
      { tsconfigPath: sameOriginStarTsconfigPath },
      sameOriginStarInputPath
    );
    const barrel = await extractFixture(
      { tsconfigPath: sameOriginStarTsconfigPath },
      sameOriginStarBarrelPath
    );

    expect(component(result, "SameOriginWrapped").props.map((entry) => entry.name)).toEqual(["a", "b"]);
    expect(
      barrel.warnings.some(
        (warning) => warning.code === "unresolved-re-export" && warning.reason === "ambiguous"
      )
    ).toBe(false);
  });
});
