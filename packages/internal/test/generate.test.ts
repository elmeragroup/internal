import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
