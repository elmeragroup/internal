import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { ExtractionResult } from "../src/index.ts";
import { extractFixture, fixtureRoot } from "./support/extract.ts";

const tsconfigPath = resolve(fixtureRoot, "module-surface-tsconfig.json");

describe("re-export provenance and authored names", () => {
  it("records the original name of a renamed module re-export on the export node", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "module-reexports-basic", "input.ts")
    );
    const root = result.module.exports.find((entry) => entry.name === "Root");
    expect(root).toBeDefined();
    // `export { RootComponent as Root } from './source'` keeps the public name…
    if (root?.name !== "Root") throw new Error("the renamed export disappeared");
    // …and records the authored source name beside it.
    expect(root.reexportedFrom).toBe("RootComponent");
    // A local alias without a module specifier does not count as a re-export.
    const aliased = result.module.exports.find((entry) => entry.name === "aliasedOverloadedFunction");
    expect(aliased).toBeUndefined();
  });

  it("records the intermediate re-export chain in provenance while the declaration paths keep the origin", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "module-reexports-basic", "input.ts")
    );
    const rootEntry = result.provenance.find((entry) => entry.path.join("/") === "Root");
    expect(rootEntry).toBeDefined();
    if (rootEntry === undefined) throw new Error("missing provenance for Root");
    // The origin is the declaring module; the chain is the forwarding hop.
    expect(
      rootEntry.declarations
        .map((declaration) => declaration.path)
        .some((path) => path.endsWith("source.tsx"))
    ).toBe(true);
    expect(rootEntry.reexportChain).toEqual(["test/fixtures/module-reexports-basic/input.ts"]);
    // A directly declared export has no chain.
    const localEntry = result.provenance.find((entry) => entry.path.join("/") === "localFunction");
    expect(localEntry?.reexportChain).toBeUndefined();
  });

  it("flattens a namespace export under its public name without emitting the namespace object", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "module-reexports-basic", "input.ts")
    );
    const names = result.module.exports.map((entry) => entry.name);
    // No bare `Source` object export exists; every member carries the namespace.
    expect(names).not.toContain("Source");
    for (const prefix of ["Source.RootProps", "Source.RootComponent", "Source.RootComponent.Props"]) {
      expect(names).toContain(prefix);
    }
    const member = result.module.exports.find((entry) => entry.name === "Source.RootComponent");
    expect(member?.type).toMatchObject({
      kind: "component",
      typeName: { name: "RootComponent", namespaces: ["Source"] },
    });
  });
});

const reviewFixtureRoot = resolve(import.meta.dirname, "fixtures/module-surface-reexport-shapes");
const reviewTsconfigPath = resolve(reviewFixtureRoot, "tsconfig.json");

function runReviewExtraction(fixture: string, file: string): Promise<ExtractionResult> {
  return extractFixture({ tsconfigPath: reviewTsconfigPath }, resolve(reviewFixtureRoot, fixture, file));
}

describe("module-surface review regressions", () => {
  it("reports a barrel cycle through namespace re-exports as a structured warning and terminates", async () => {
    // input -> Loop -> Back -> input: the second visit of the input module
    // hits the visited set, so flattening stops with one warning instead of
    // recursing forever.
    const result = await runReviewExtraction("cycle", "input.ts");
    expect(result.warnings).toHaveLength(1);
    const warning = result.warnings[0];
    if (warning?.code !== "unresolved-re-export") {
      throw new Error(`expected unresolved-re-export, got ${warning?.code ?? "nothing"}`);
    }
    expect(warning.reason).toBe("cycle");
    expect(warning.name).toBe("Loop.Back.Loop");
    // The cut keeps extraction alive; no phantom exports are manufactured for
    // the branch that could not be followed.
    expect(result.module.exports).toEqual([]);
  });

  it("reports an unresolvable default export expression like upstream does", async () => {
    // `export default <arrow>` anchors no symbol under TypeScript 7's
    // declaration-shaped default exports; upstream emits the same condition
    // (`missing-default-export-symbol`) and skips the export.
    const result = await runReviewExtraction("default-arrow", "input.ts");
    expect(result.module.exports).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    const warning = result.warnings[0];
    if (warning?.code !== "missing-default-export-symbol") {
      throw new Error(`expected missing-default-export-symbol, got ${warning?.code ?? "nothing"}`);
    }
    expect(warning.sourceText).toBe("() => ({ ok: true })");
    expect(warning.message).toContain('Could not resolve default export "() => ({ ok: true })"');
    expect(warning.message).toContain("Name the declaration before exporting it");
  });

  it("records every intermediate forwarding file of a multi-hop re-export chain", async () => {
    // input -> middle -> origin: each forwarding file appears in
    // `reexportChain` outermost first, and the origin stays only in
    // `declarations`. Both value and type-only re-exports are pinned.
    const result = await runReviewExtraction("multi-hop", "input.ts");
    const names = result.module.exports.map((entry) => entry.name);
    expect(names).toEqual(["ping", "Pong"]);
    for (const name of ["ping", "Pong"]) {
      const entry = result.provenance.find((candidate) => candidate.path.join("/") === name);
      expect(entry).toBeDefined();
      if (entry === undefined) throw new Error(`missing provenance for ${name}`);
      expect(entry.reexportChain).toEqual([
        "fixtures/module-surface-reexport-shapes/multi-hop/input.ts",
        "fixtures/module-surface-reexport-shapes/multi-hop/middle.ts",
      ]);
      expect(
        entry.declarations.map((declaration) => declaration.path).some((path) => path.endsWith("origin.ts"))
      ).toBe(true);
    }
  });

  it("never reports ambiguity for clean inputs: TypeScript rejects star collisions at typecheck time", async () => {
    // TS2308 makes a two-star collision on one name a compile ERROR, so a
    // project that passes the fixture typecheck gate cannot contain one. The
    // extractor still carries the `ambiguous` reason for projects extracted
    // without that guarantee; it is intentionally unrepresentable here because
    // every fixture input must typecheck independently.
    const result = await runReviewExtraction("cycle", "input.ts");
    expect(
      result.warnings.some(
        (warning) => warning.code === "unresolved-re-export" && warning.reason === "ambiguous"
      )
    ).toBe(false);
  });
});
