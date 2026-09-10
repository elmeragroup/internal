import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = process.cwd();
await writeFile("tree-shake.mjs", 'export { ApiArtifactsError } from "@elmeragroup/internal";\n');
const { build } = await import("esbuild");
await build({
  entryPoints: ["tree-shake.mjs"],
  outdir: "consumer-dist",
  outExtension: { ".js": ".mjs" },
  platform: "browser",
  format: "esm",
  bundle: true,
  external: ["node:*"],
});
const emitted = await readdir("consumer-dist", { recursive: true });
assert.deepEqual(emitted, ["tree-shake.mjs"], "Unused generator chunks must be removed");
const bundled = await readFile("consumer-dist/tree-shake.mjs", "utf8");
assert.doesNotMatch(bundled, /(?:from\s*|import\s*\(?)["'](?:effect|typescript|node:|@elmeragroup\/)/);
assert.doesNotMatch(bundled, /generateApiArtifacts|ProjectExtractor|eslintCompatPlugin/);
assert.doesNotMatch(bundled, /releaseCheckedCommit|retryRelease|verified-release\.tgz|elmera\/release\//);
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
console.log("Independent consumer tree-shaking passed.");
