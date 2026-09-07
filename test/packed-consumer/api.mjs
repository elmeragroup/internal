import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ApiArtifactsDriftError, generateApiArtifacts } from "@elmeragroup/internal";

const root = process.cwd();
const internalRequire = createRequire(import.meta.resolve("@elmeragroup/internal"));
const { ProjectExtractor } = await import("@elmeragroup/internal/api-extractor");
// SAFETY: resolve Effect from the installed umbrella to share its service runtime.
const { Effect } = /** @type {typeof import("effect")} */ (
  await import(pathToFileURL(internalRequire.resolve("effect")).href)
);
const artifacts = await import("@elmeragroup/internal/api-artifacts");
assert.equal(artifacts.generateApiArtifacts, generateApiArtifacts);
assert.equal(artifacts.ApiArtifactsDriftError, ApiArtifactsDriftError);
await mkdir("node_modules/@base-ui/react", { recursive: true });
await writeFile(
  "node_modules/@base-ui/react/package.json",
  JSON.stringify({ name: "@base-ui/react", version: "0.0.0", types: "index.d.ts" })
);
await writeFile(
  "node_modules/@base-ui/react/index.d.ts",
  `export type Props = {
/** Whether the trigger is disabled. */
disabled?: boolean;
};`
);
await writeFile(
  "tsconfig.json",
  JSON.stringify({
    compilerOptions: {
      strict: true,
      module: "NodeNext",
      moduleResolution: "NodeNext",
      target: "ES2022",
      lib: ["ES2022", "DOM"],
      types: [],
      skipLibCheck: false,
      noEmit: true,
    },
    include: ["button.ts", "consumer.ts"],
  })
);
await writeFile(
  "button.ts",
  `"use client";
import type { Props as BaseProps } from "@base-ui/react";
export type Props = BaseProps & {
/** Visible label. */
label: string;
};
export function Button({ label, disabled = false }: Props) { return label; }
`
);
const options = {
  projectRoot: root,
  tsconfigPath: "tsconfig.json",
  components: [
    { slug: "button", entryFile: "button.ts", exportNames: ["Button"], outputFile: "docs/button/api.json" },
  ],
};
const first = await generateApiArtifacts(options);
assert.equal(first.components.length, 1);
assert.equal(first.components[0].parts[0].rsc, "client");
assert.deepEqual(
  first.components[0].parts[0].props.map((prop) => prop.name),
  ["label", "disabled"]
);
assert.equal(first.components[0].parts[0].props[1].defaultValue, "false");
assert.deepEqual(first.components[0].parts[0].props[1].origin, { packageName: "@base-ui/react" });
assert.match(first.components[0].$generated, /@elmeragroup\/internal/);
const before = await stat("docs/button/api.json");
await generateApiArtifacts(options);
assert.equal((await stat("docs/button/api.json")).mtimeMs, before.mtimeMs);
await generateApiArtifacts({ ...options, mode: "check" });
await writeFile("docs/button/api.json", "stale\n");
await assert.rejects(generateApiArtifacts({ ...options, mode: "check" }), ApiArtifactsDriftError);
assert.equal(await readFile("docs/button/api.json", "utf8"), "stale\n");
const extracted = await Effect.runPromise(
  Effect.gen(function* () {
    const extractor = yield* ProjectExtractor;
    return yield* extractor.extractModule(path.join(root, "button.ts"));
  }).pipe(
    Effect.provide(ProjectExtractor.live({ tsconfigPath: path.join(root, "tsconfig.json"), cwd: root }))
  )
);
assert.ok(extracted.module.exports.some((entry) => entry.name === "Button"));
const inspected = await Effect.runPromise(
  Effect.gen(function* () {
    const extractor = yield* ProjectExtractor;
    return yield* extractor.inspectComponentSources(path.join(root, "button.ts"), [{ exportName: "Button" }]);
  }).pipe(
    Effect.provide(ProjectExtractor.live({ tsconfigPath: path.join(root, "tsconfig.json"), cwd: root }))
  )
);
assert.equal(inspected.length, 1);
assert.equal(inspected[0].status, "resolved");
assert.equal(inspected[0].filePath, path.join(root, "button.ts"));
assert.deepEqual(inspected[0].defaults, [{ name: "disabled", initializerText: "false" }]);
assert.equal("declaration" in inspected[0], false);
