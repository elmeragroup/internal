import { Schema } from "effect";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

import { runCommand } from "./lib/run-command.ts";
import { archiveDirectory, archivePath, packageDirectory, packageName, releaseVersion } from "./release.ts";

/**
 * The stricter shape of this repository's packed publish manifest. Unlike the package's
 * `PackageManifest`, which must read consumer packages too, these fields are ours and every one is
 * required to be absent or exactly as packaging expects.
 */
const PublishManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  private: Schema.optionalKey(Schema.Boolean),
  sideEffects: Schema.optionalKey(Schema.Boolean),
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  exports: Schema.optionalKey(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String))),
});

const version = releaseVersion();
rmSync(archiveDirectory, { recursive: true, force: true });
mkdirSync(archiveDirectory, { recursive: true });
runCommand("pnpm", ["pack", "--pack-destination", archiveDirectory], packageDirectory);
const archive = archivePath(version);
const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
if (files.some((file) => !/^package\/(?:dist\/|package\.json$|README\.md$|LICENSE$|NOTICE$)/.test(file)))
  throw new Error(`${packageName}: unexpected published file`);
if (
  files.some(
    (file) =>
      /\/(?:test|fixtures|node_modules)\//.test(file) ||
      (/\.[cm]?ts$/.test(file) && !/\.d\.[cm]?ts$/.test(file))
  )
)
  throw new Error(`${packageName}: tests or TypeScript sources in archive`);
const manifest = Schema.decodeUnknownSync(PublishManifest)(
  JSON.parse(execFileSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" }))
);
if (manifest.private === true || manifest.version !== version)
  throw new Error(`${packageName}: invalid publish manifest`);
const dependencies = manifest.dependencies ?? {};
for (const [dependency, specifier] of Object.entries(dependencies)) {
  if (/^(?:workspace|catalog|file|link):/.test(specifier))
    throw new Error(`${packageName}: unresolved dependency ${dependency}`);
  if (dependency.startsWith("@elmeragroup/"))
    throw new Error(`${packageName}: private workspace dependency ${dependency}`);
}
if (!dependencies.typescript || !dependencies.effect || !dependencies["@oxlint/plugins"])
  throw new Error(`${packageName}: external runtime dependency missing`);
if (
  !files.includes("package/dist/index.mjs") ||
  !files.includes("package/dist/index.d.mts") ||
  !files.includes("package/LICENSE")
)
  throw new Error(`${packageName}: missing entry or license`);
const expectedExports = [
  ".",
  "./api-artifacts",
  "./api-artifacts/model",
  "./api-extractor",
  "./oxlint",
  "./oxlint/anti-slop",
  "./release",
];
const exports = manifest.exports ?? {};
if (JSON.stringify(Object.keys(exports)) !== JSON.stringify(expectedExports))
  throw new Error(`${packageName}: unexpected public exports`);
for (const [entry, conditions] of Object.entries(exports)) {
  for (const target of Object.values(conditions)) {
    if (!files.includes(`package/${target.slice(2)}`))
      throw new Error(`${packageName}: missing export target ${entry}`);
  }
}
if (manifest.sideEffects !== false) throw new Error(`${packageName}: unexpected sideEffects metadata`);
for (const file of files.filter((file) => /\.[cm]?[jt]s$/.test(file))) {
  const source = execFileSync("tar", ["-xOzf", archive, file], { encoding: "utf8" });
  if (/(?:from\s*|import\s*\(?)["']@elmeragroup\//.test(source))
    throw new Error(`${file}: unpublished workspace import`);
}
const notice = execFileSync("tar", ["-xOzf", archive, "package/NOTICE"], { encoding: "utf8" });
if (!notice.includes("Dillon Mulroy") || !notice.includes("Michał Dudak"))
  throw new Error(`${packageName}: missing third-party attribution`);
console.log(JSON.stringify({ version, archive }, null, 2));
