import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ApiArtifactsDriftError, generateApiArtifacts } from "@elmeragroup/internal";

const root = process.cwd();
const require = createRequire(import.meta.url);
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
await writeFile(
  "consumer.ts",
  `import { generateApiArtifacts } from "@elmeragroup/internal";
import type { GenerateApiArtifactsOptions } from "@elmeragroup/internal/api-artifacts";
import type { ApiPart } from "@elmeragroup/internal/api-artifacts/model";
import { ProjectExtractor } from "@elmeragroup/internal/api-extractor";
import elmera from "@elmeragroup/internal/oxlint";
import antiSlop from "@elmeragroup/internal/oxlint/anti-slop";
void ProjectExtractor;
void elmera;
void antiSlop;
const options: GenerateApiArtifactsOptions = { projectRoot: ".", tsconfigPath: "tsconfig.json", components: [] };
const result = await generateApiArtifacts(options);
const parts: readonly ApiPart[] = result.components.flatMap(component => component.parts);
void parts;
`
);
const compilerRoot = path.dirname(internalRequire.resolve("typescript/package.json"));
execFileSync(process.execPath, [path.join(compilerRoot, "bin/tsc"), "-p", "tsconfig.json"], {
  stdio: "inherit",
});
await writeFile(
  "model-consumer.ts",
  `import type { ApiArtifactDiagnostic, ApiPart } from "@elmeragroup/internal/api-artifacts/model";
export type BrowserModel = { part: ApiPart; diagnostic: ApiArtifactDiagnostic };
`
);
await writeFile(
  "tsconfig.model.json",
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
    files: ["model-consumer.ts"],
  })
);
execFileSync(process.execPath, [path.join(compilerRoot, "bin/tsc"), "-p", "tsconfig.model.json"], {
  stdio: "inherit",
});
console.log(
  "Packed umbrella, extraction, dependency defaults, drift checks, and consumer declarations passed."
);

await writeFile(
  "reject-compiler.mjs",
  `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (/^(?:effect|typescript)(?:\\/|$)/.test(specifier)) throw new Error("Unexpected runtime import: " + specifier);
  return nextResolve(specifier, context);
}});
`
);
await writeFile(
  "check-entries.mjs",
  `import assert from "node:assert/strict";
const model = await import("@elmeragroup/internal/api-artifacts/model");
assert.deepEqual(Object.keys(model), []);
const { default: elmera } = await import("@elmeragroup/internal/oxlint");
const { default: antiSlop } = await import("@elmeragroup/internal/oxlint/anti-slop");
assert.ok(elmera.rules["no-tailwind-dark-variant"]);
assert.ok(antiSlop.rules["no-reflect-get"]);
`
);
execFileSync(
  process.execPath,
  ["--no-experimental-strip-types", "--import", "./reject-compiler.mjs", "check-entries.mjs"],
  { stdio: "inherit" }
);
await writeFile(
  ".oxlintrc.json",
  JSON.stringify({
    jsPlugins: [
      { name: "elmera", specifier: "@elmeragroup/internal/oxlint" },
      { name: "anti-slop", specifier: "@elmeragroup/internal/oxlint/anti-slop" },
    ],
    rules: { "elmera/no-tailwind-dark-variant": "error", "anti-slop/no-reflect-get": "error" },
  })
);
await writeFile(
  "lint-input.ts",
  'export const classes = "dark:bg-red-500";\nexport const value = Reflect.get({}, "key");\n'
);
const oxlint = path.join(path.dirname(require.resolve("oxlint/package.json")), "bin/oxlint");
const lint = spawnSync(oxlint, ["--config", ".oxlintrc.json", "lint-input.ts"], {
  encoding: "utf8",
  env: {
    ...process.env,
    NODE_OPTIONS: `--no-experimental-strip-types --import=${path.join(root, "reject-compiler.mjs")}`,
  },
});
assert.equal(lint.status, 1, lint.stdout + lint.stderr);
assert.match(lint.stdout + lint.stderr, /no-tailwind-dark-variant/);
assert.match(lint.stdout + lint.stderr, /no-reflect-get/);
assert.doesNotMatch(lint.stdout + lint.stderr, /Unexpected runtime import/);
await writeFile("tree-shake.mjs", 'export { ApiArtifactsError } from "@elmeragroup/internal";\n');
const { build } = await import("tsdown");
await build({
  entry: "tree-shake.mjs",
  outDir: "consumer-dist",
  platform: "browser",
  fixedExtension: true,
  format: "esm",
  dts: false,
  deps: { alwaysBundle: [/^@elmeragroup\//], neverBundle: [/^node:/] },
});
const emitted = await readdir("consumer-dist", { recursive: true });
assert.deepEqual(emitted, ["tree-shake.mjs"], "Unused generator chunks must be removed");
const bundled = await readFile("consumer-dist/tree-shake.mjs", "utf8");
assert.doesNotMatch(bundled, /(?:from\s*|import\s*\(?)["'](?:effect|typescript|node:|@elmeragroup\/)/);
assert.doesNotMatch(bundled, /generateApiArtifacts|ProjectExtractor|eslintCompatPlugin/);
assert.ok(bundled.length < 4000, `Error-only consumer retained ${bundled.length} bytes`);
// SAFETY: this bundle re-exports only the installed public error class.
const { ApiArtifactsError } =
  /** @type {Pick<typeof import("@elmeragroup/internal"), "ApiArtifactsError">} */ (
    await import(pathToFileURL(path.join(root, "consumer-dist/tree-shake.mjs")).href)
  );
assert.equal(
  new ApiArtifactsError(["packed consumer"]).message,
  "API artifact generation failed:\npacked consumer"
);
console.log(
  "All public entries, lint isolation, actual Oxlint diagnostics, and consumer tree-shaking passed."
);
