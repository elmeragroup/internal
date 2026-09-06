import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ApiArtifactsDriftError, ApiArtifactsError, generateApiArtifacts } from "../src/index.ts";

const roots: string[] = [];
async function fixture(
  source = `"use client";
export type Props = {
  /** Label shown on the button. */
  label: string;
  /** Whether interaction is disabled. */
  disabled?: boolean;
};
export function Button({ label, disabled = false }: Props) { return label; }
export const Compound = { Root: Button };
`
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "api-artifacts-"));
  roots.push(root);
  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, types: [], module: "ESNext", moduleResolution: "Bundler" },
      include: ["*.ts"],
    })
  );
  await writeFile(path.join(root, "button.ts"), source);
  return root;
}
function options(projectRoot: string) {
  return {
    projectRoot,
    tsconfigPath: "tsconfig.json",
    components: [
      {
        slug: "button",
        entryFile: "button.ts",
        exportNames: ["Button", "Compound"],
        outputFile: "docs/button/api.json",
      },
    ],
  };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("generateApiArtifacts", () => {
  it("writes standalone and compound parts with defaults, documentation, and source status", async () => {
    const root = await fixture();
    const result = await generateApiArtifacts(options(root));
    const component = result.components[0];
    expect(component?.parts.map((part) => part.name)).toEqual(["Button", "Compound.Root"]);
    expect(component?.parts[0]).toMatchObject({ rsc: "client", sourcePath: "button.ts", forwardedCount: 0 });
    expect(component?.parts[0]?.props).toEqual([
      {
        name: "disabled",
        origin: "declared",
        type: "boolean | undefined",
        shortType: null,
        defaultValue: "false",
        description: "Whether interaction is disabled.",
        required: false,
      },
      {
        name: "label",
        origin: "declared",
        type: "string",
        shortType: null,
        defaultValue: null,
        description: "Label shown on the button.",
        required: true,
      },
    ]);
    expect(await readFile(path.join(root, "docs/button/api.json"), "utf8")).toBe(component?.text);
  });

  it("checks without writing and preserves mtimes on unchanged generation", async () => {
    const root = await fixture();
    const input = options(root);
    const file = path.join(root, "docs/button/api.json");
    await expect(generateApiArtifacts({ ...input, mode: "check" })).rejects.toBeInstanceOf(
      ApiArtifactsDriftError
    );
    await expect(stat(path.dirname(file))).rejects.toMatchObject({ code: "ENOENT" });
    await generateApiArtifacts(input);
    const before = await stat(file);
    expect((await generateApiArtifacts(input)).components[0]?.changed).toBe(false);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    await generateApiArtifacts({ ...input, mode: "check" });
    await writeFile(file, "stale\n");
    await expect(generateApiArtifacts({ ...input, mode: "check" })).rejects.toBeInstanceOf(
      ApiArtifactsDriftError
    );
    expect(await readFile(file, "utf8")).toBe("stale\n");
  });

  it("validates all components before changing existing artifacts", async () => {
    const root = await fixture();
    const input = options(root);
    await generateApiArtifacts(input);
    const file = path.join(root, "docs/button/api.json");
    await writeFile(file, "keep me\n");
    await writeFile(
      path.join(root, "bad.ts"),
      "export function Bad(props: { undocumented: string }) { return props.undocumented; }"
    );
    await expect(
      generateApiArtifacts({
        ...input,
        components: [
          ...input.components,
          { slug: "bad", entryFile: "bad.ts", exportNames: ["Bad"], outputFile: "docs/bad/api.json" },
        ],
      })
    ).rejects.toBeInstanceOf(ApiArtifactsError);
    expect(await readFile(file, "utf8")).toBe("keep me\n");
  });

  it("rejects duplicate identities and output paths before extraction", async () => {
    const root = await fixture();
    const input = options(root);
    await expect(
      generateApiArtifacts({ ...input, components: [...input.components, ...input.components] })
    ).rejects.toThrow("duplicate component slug");
    await expect(
      generateApiArtifacts({
        ...input,
        components: [
          ...input.components,
          {
            slug: "other",
            entryFile: "button.ts",
            exportNames: ["Button"],
            outputFile: "docs/button/../button/api.json",
          },
        ],
      })
    ).rejects.toThrow("Duplicate or non-JSON output");
  });

  it("reports missing exports and supports server functions without props", async () => {
    const root = await fixture("export function Server() { return null; }");
    await expect(generateApiArtifacts(options(root))).rejects.toThrow('does not export "Button"');
    const result = await generateApiArtifacts({
      ...options(root),
      components: [
        { slug: "server", entryFile: "button.ts", exportNames: ["Server"], outputFile: "server.json" },
      ],
    });
    expect(result.components[0]?.parts[0]).toMatchObject({ name: "Server", rsc: "server", props: [] });
  });

  it("does not let artifact output overwrite the project configuration", async () => {
    const root = await fixture();
    const original = await readFile(path.join(root, "tsconfig.json"), "utf8");
    await expect(
      generateApiArtifacts({
        ...options(root),
        components: [
          { slug: "button", entryFile: "button.ts", exportNames: ["Button"], outputFile: "tsconfig.json" },
        ],
      })
    ).rejects.toThrow("tsconfig cannot be an artifact output");
    expect(await readFile(path.join(root, "tsconfig.json"), "utf8")).toBe(original);
  });

  it("selects only documented props from the named dependency", async () => {
    const root = await fixture(`import type { ExternalProps } from "fixture-dependency";
export type Props = ExternalProps & {
/** Local label. */
label: string;
};
export function Button(props: Props) { return props.label; }
export const Compound = { Root: Button };
`);
    const dependency = path.join(root, "node_modules/fixture-dependency");
    await mkdir(dependency, { recursive: true });
    await writeFile(
      path.join(dependency, "package.json"),
      JSON.stringify({ name: "fixture-dependency", version: "1.0.0", types: "index.d.ts" })
    );
    await writeFile(
      path.join(dependency, "index.d.ts"),
      `export type ExternalProps = {
/** External description.
 * @default false
 */
external?: boolean;
undocumented?: string;
};`
    );
    await expect(
      generateApiArtifacts({ ...options(root), includeExternalTypes: ["fixture-dependency"] })
    ).rejects.toThrow("unsupported-type-fallback");
    const result = await generateApiArtifacts({
      ...options(root),
      includeExternalTypes: ["fixture-dependency"],
      allowedWarningCodes: ["unsupported-type-fallback"],
    });
    expect(result.diagnostics.some(({ warning }) => warning.code === "unsupported-type-fallback")).toBe(true);
    expect(result.components[0]?.parts[0]?.props.map((prop) => prop.name)).toEqual(["label", "external"]);
    expect(result.components[0]?.parts[0]?.props[1]).toMatchObject({
      origin: { packageName: "fixture-dependency" },
      description: "External description.",
      defaultValue: "false",
      required: false,
    });
    expect(result.components[0]?.parts[0]?.forwardedCount).toBe(1);
  });
});
