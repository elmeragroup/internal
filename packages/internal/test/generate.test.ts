import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { generateApiArtifacts } from "../src/index.ts";

it("supports the root entry and consumer overrides", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "internal-api-"));
  try {
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, types: [] }, include: ["index.ts"] })
    );
    await writeFile(path.join(root, "index.ts"), "export function Example() { return null; }");
    const result = await generateApiArtifacts({
      projectRoot: root,
      tsconfigPath: "tsconfig.json",
      components: [
        { slug: "example", entryFile: "index.ts", exportNames: ["Example"], outputFile: "api.json" },
      ],
      includeExternalTypes: [],
      generatedBy: "Custom generator",
    });
    expect(result.components[0]?.$generated).toBe("Custom generator");
    expect(await readFile(path.join(root, "api.json"), "utf8")).toBe(result.components[0]?.text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps a default Base UI facade prop-free when includeExternalTypes is omitted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "internal-api-"));
  try {
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          types: [],
          module: "ESNext",
          moduleResolution: "Bundler",
          skipLibCheck: true,
        },
        include: ["index.ts", "src/**/*.tsx"],
      })
    );
    await mkdir(path.join(root, "node_modules/@base-ui/react"), { recursive: true });
    await writeFile(
      path.join(root, "node_modules/@base-ui/react/package.json"),
      JSON.stringify({
        name: "@base-ui/react",
        version: "0.0.0",
        type: "module",
        main: "./index.js",
        types: "./index.d.ts",
      })
    );
    await writeFile(path.join(root, "node_modules/@base-ui/react/index.js"), "export function Toggle() {}\n");
    await writeFile(
      path.join(root, "node_modules/@base-ui/react/index.d.ts"),
      `export interface ToggleProps {
  /** Whether the toggle is pressed. */
  pressed?: boolean;
}
export declare function Toggle(props: ToggleProps): null;
`
    );
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "src/toggle.tsx"),
      `"use client";
export { Toggle } from "@base-ui/react";
`
    );
    await writeFile(path.join(root, "index.ts"), `export { Toggle } from "./src/toggle";\n`);
    const result = await generateApiArtifacts({
      projectRoot: root,
      tsconfigPath: "tsconfig.json",
      components: [
        { slug: "toggle", entryFile: "index.ts", exportNames: ["Toggle"], outputFile: "api.json" },
      ],
    });
    expect(result.components[0]?.parts).toEqual([
      {
        name: "Toggle",
        rsc: "client",
        sourcePath: "src/toggle.tsx",
        props: [],
        forwardedFrom: ["@base-ui/react"],
        forwardedCount: 1,
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
