import { Schema } from "effect";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { ExtractionResultSchema } from "../src/index.ts";
import type { ComponentNode, ExtractionResult, ExtractorOptions } from "../src/index.ts";
import { extractFixture } from "./support/extract.ts";

const fixtureRoot = resolve(import.meta.dirname, "fixtures/package-selective-external-types");
const inputPath = resolve(fixtureRoot, "input.ts");
const tsconfigPath = resolve(fixtureRoot, "tsconfig.json");
const unknownOwnerPackagePath = resolve(fixtureRoot, "node_modules/unknown-owner/index.d.ts");
const unknownOwnerDeclarationPath = resolve(fixtureRoot, "external-types/unknown-owner/index.d.ts");

function runExtraction(options?: ExtractorOptions): Promise<ExtractionResult> {
  return extractFixture(
    {
      tsconfigPath,
      fileSystem: {
        realpath: (path) => (path === unknownOwnerPackagePath ? unknownOwnerDeclarationPath : undefined),
      },
    },
    inputPath,
    options
  );
}

function primitiveComponent(result: ExtractionResult): ComponentNode {
  const entry = result.module.exports.find((candidate) => candidate.name === "PrimitiveComponent");
  if (entry?.type.kind !== "component") throw new Error("Expected PrimitiveComponent component export");
  return entry.type;
}

function stableResult(result: ExtractionResult): string {
  return JSON.stringify({ module: result.module, warnings: result.warnings, provenance: result.provenance });
}

describe("package-selective external-type expansion", () => {
  it("preserves symlinked workspace ownership and provenance with preserveSymlinks", async () => {
    const temporaryWorkspace = mkdtempSync(join(tmpdir(), "api-extractor-preserve-symlinks-"));
    const workspaceRoot = temporaryWorkspace;
    const consumerDirectory = join(workspaceRoot, "consumer");
    const dependencyDirectory = join(workspaceRoot, "workspace-dependency");
    const dependencyLink = join(consumerDirectory, "node_modules", "@fixture", "workspace-dependency");
    const input = join(consumerDirectory, "input.ts");
    const tsconfig = join(consumerDirectory, "tsconfig.json");

    try {
      mkdirSync(dependencyDirectory, { recursive: true });
      mkdirSync(join(consumerDirectory, "node_modules", "@fixture"), { recursive: true });
      writeFileSync(
        join(dependencyDirectory, "package.json"),
        JSON.stringify({
          name: "@fixture/workspace-dependency",
          version: "1.0.0",
          types: "./index.d.ts",
        })
      );
      writeFileSync(
        join(dependencyDirectory, "index.d.ts"),
        "export interface WorkspaceShape { externalLabel: string; }\n"
      );
      symlinkSync(dependencyDirectory, dependencyLink, process.platform === "win32" ? "junction" : "dir");
      writeFileSync(
        input,
        [
          'import type { WorkspaceShape } from "@fixture/workspace-dependency";',
          "export interface PublicShape extends WorkspaceShape { localLabel: string; }",
          "",
        ].join("\n")
      );
      writeFileSync(
        tsconfig,
        JSON.stringify({
          compilerOptions: {
            module: "ESNext",
            moduleResolution: "Bundler",
            noEmit: true,
            preserveSymlinks: true,
            rootDir: ".",
            strict: true,
            target: "ES2022",
          },
          // Both identities are registered. The imported symlink must still
          // keep its external-library metadata instead of becoming this root.
          include: ["input.ts", "../workspace-dependency/index.d.ts"],
        })
      );

      const extract = (options?: ExtractorOptions) =>
        extractFixture({ cwd: workspaceRoot, tsconfigPath: tsconfig }, input, options);
      const defaultResult = await extract();
      const expandedResult = await extract({ includeExternalTypes: true });
      const defaultPublicExport = defaultResult.module.exports.find((entry) => entry.name === "PublicShape");
      const expandedPublicExport = expandedResult.module.exports.find(
        (entry) => entry.name === "PublicShape"
      );
      if (defaultPublicExport?.type.kind !== "object" || expandedPublicExport?.type.kind !== "object") {
        throw new Error("Expected PublicShape object exports");
      }

      expect(defaultPublicExport.type.properties.map((property) => property.name)).toEqual(["localLabel"]);
      expect(expandedPublicExport.type.properties.map((property) => property.name)).toEqual([
        "externalLabel",
        "localLabel",
      ]);
      expect(expandedResult.provenance).toContainEqual({
        path: ["PublicShape", "properties", "externalLabel"],
        declarations: [
          {
            path: "consumer/node_modules/@fixture/workspace-dependency/index.d.ts",
            owner: { kind: "dependency", packageName: "@fixture/workspace-dependency" },
          },
        ],
        synthesized: false,
      });
    } finally {
      rmSync(temporaryWorkspace, { recursive: true, force: true });
    }
  });

  it("expands ordinary props from exactly the selected scoped dependency", async () => {
    const result = await runExtraction({ includeExternalTypes: ["@fixture/selected"] });
    const props = new Map(primitiveComponent(result).props.map((property) => [property.name, property]));

    expect([...props.keys()]).toEqual(["focusableWhenDisabled", "foreignDetail", "onAction", "localLabel"]);
    expect(props.get("focusableWhenDisabled")?.documentation).toEqual({
      description: "Allows the primitive to remain focusable while disabled.",
      defaultValue: "false",
      tags: [],
    });
    expect(props.get("foreignDetail")?.type).toMatchObject({
      kind: "external",
      typeName: { name: "ForeignDetail" },
    });
    expect(props.get("onAction")?.type).toMatchObject({
      kind: "union",
      types: [
        {
          kind: "external",
          typeName: {
            name: "MouseEventHandler",
            namespaces: ["React"],
            typeArguments: [
              {
                type: { kind: "external", typeName: { name: "HTMLButtonElement" } },
                equalToDefault: false,
              },
            ],
          },
        },
        { kind: "intrinsic", intrinsic: "undefined" },
      ],
    });
    expect(props.has("prefixedPackageProp")).toBe(false);
    expect(result.provenance).toContainEqual({
      path: ["PrimitiveComponent", "props", "focusableWhenDisabled"],
      declarations: [
        {
          path: "test/fixtures/package-selective-external-types/node_modules/@fixture/selected/button.d.ts",
          owner: { kind: "dependency", packageName: "@fixture/selected" },
        },
      ],
      synthesized: false,
    });
    expect(Schema.decodeUnknownSync(ExtractionResultSchema)(result)).toEqual(result);
  });

  it("uses the same selection for mapped members, keyof, and mixed declaration owners", async () => {
    const result = await runExtraction({ includeExternalTypes: ["@fixture/selected"] });
    const exports = new Map(result.module.exports.map((entry) => [entry.name, entry.type]));

    expect(exports.get("SelectedMappedUse")).toMatchObject({
      kind: "object",
      properties: [{ name: "mappedOne" }, { name: "mappedTwo" }],
    });
    expect(exports.get("SelectedKeysUse")).toMatchObject({
      kind: "typeOperator",
      operator: "keyof",
      type: {
        kind: "object",
        typeName: { name: "SelectedKeySource" },
        properties: [],
      },
    });
    expect(exports.get("MixedOwner")).toEqual({ kind: "object", properties: [] });
    expect(exports.get("SelectedOwner")).toMatchObject({
      kind: "object",
      properties: [{ name: "selectedMember" }],
    });
    expect(exports.get("UnselectedMappedUse")).toMatchObject({
      kind: "external",
      typeName: { name: "ForeignMapped" },
    });
    expect(exports.get("UnselectedKeysUse")).toEqual({
      kind: "union",
      types: [
        { kind: "literal", value: '"foreignAlpha"' },
        { kind: "literal", value: '"foreignBeta"' },
      ],
    });

    const wrapped = exports.get("WrappedComponent");
    expect(wrapped?.kind).toBe("component");
    if (wrapped?.kind !== "component") throw new Error("React.FC wrapper recognition regressed");
    expect(wrapped.props.map((property) => property.name)).toEqual([
      "focusableWhenDisabled",
      "foreignDetail",
      "onAction",
      "localLabel",
    ]);
    expect(exports.get("SelectedUtilityUse")).toMatchObject({
      kind: "object",
      properties: [{ name: "focusableWhenDisabled" }, { name: "localLabel" }],
    });
  });

  it("preserves default and boolean behavior while treating an empty list as disabled", async () => {
    const [omitted, disabled, empty, enabled] = await Promise.all([
      runExtraction(),
      runExtraction({ includeExternalTypes: false }),
      runExtraction({ includeExternalTypes: [] }),
      runExtraction({ includeExternalTypes: true }),
    ]);

    expect(stableResult(disabled)).toBe(stableResult(omitted));
    expect(stableResult(empty)).toBe(stableResult(omitted));
    expect(primitiveComponent(omitted).props.map((property) => property.name)).toEqual(["localLabel"]);
    expect(primitiveComponent(enabled).props.map((property) => property.name)).toEqual([
      "focusableWhenDisabled",
      "foreignDetail",
      "onAction",
      "prefixedPackageProp",
      "localLabel",
    ]);
    expect(
      primitiveComponent(enabled).props.find((property) => property.name === "foreignDetail")?.type.kind
    ).not.toBe("external");
  });

  it("matches exact package owners deterministically and copies caller lists", async () => {
    const packages = ["@fixture/selected"];
    const selectedWhileMutating = runExtraction({
      includeExternalTypes: packages,
      shouldInclude: () => {
        packages.push("@fixture/selected-extra");
        return true;
      },
    });
    const [
      firstOrder,
      secondOrder,
      caseMismatch,
      subpathEntry,
      samePrefix,
      typescript,
      unknownOwnerSentinel,
      copied,
    ] = await Promise.all([
      runExtraction({
        includeExternalTypes: ["@fixture/selected", "@fixture/selected-extra", "@fixture/selected"],
      }),
      runExtraction({ includeExternalTypes: ["@fixture/selected-extra", "@fixture/selected"] }),
      runExtraction({ includeExternalTypes: ["@fixture/Selected"] }),
      runExtraction({ includeExternalTypes: ["@fixture/selected/button"] }),
      runExtraction({ includeExternalTypes: ["@fixture/selected-extra"] }),
      runExtraction({ includeExternalTypes: ["typescript"] }),
      runExtraction({ includeExternalTypes: ["<external>"] }),
      selectedWhileMutating,
    ]);
    const disabled = await runExtraction({ includeExternalTypes: false });

    expect(stableResult(firstOrder)).toBe(stableResult(secondOrder));
    expect(stableResult(caseMismatch)).toBe(stableResult(disabled));
    expect(stableResult(subpathEntry)).toBe(stableResult(disabled));
    expect(stableResult(typescript)).toBe(stableResult(disabled));
    expect(stableResult(unknownOwnerSentinel)).toBe(stableResult(disabled));
    expect(
      unknownOwnerSentinel.module.exports.find((entry) => entry.name === "UnknownOwnerWrapper")?.type
    ).toMatchObject({
      kind: "object",
      properties: [
        {
          name: "unknownOwner",
          type: { kind: "external", typeName: { name: "UnknownOwner" } },
        },
      ],
    });
    expect(primitiveComponent(samePrefix).props.map((property) => property.name)).toEqual([
      "prefixedPackageProp",
      "localLabel",
    ]);
    expect(primitiveComponent(copied).props.some((property) => property.name === "prefixedPackageProp")).toBe(
      false
    );
  });

  it("allows existing callbacks to narrow selected dependency shapes", async () => {
    const baseline = await runExtraction({ includeExternalTypes: ["@fixture/selected"] });
    const narrowed = await runExtraction({
      includeExternalTypes: ["@fixture/selected"],
      shouldInclude: ({ name }) => name !== "focusableWhenDisabled",
      shouldResolveObject: ({ name }) => (name === "SelectedOwner" ? false : undefined),
    });
    const props = primitiveComponent(narrowed).props.map((property) => property.name);
    const selectedOwner = narrowed.module.exports.find((entry) => entry.name === "SelectedOwner");

    expect(props).toEqual(["foreignDetail", "onAction", "localLabel"]);
    expect(selectedOwner?.type).toEqual({
      kind: "object",
      typeName: { name: "SelectedOwner" },
      properties: [],
    });
    expect(narrowed.warnings).toEqual(baseline.warnings);
  });
});
