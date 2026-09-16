import { Schema } from "effect";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

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
const archiveRoot = archiveDirectory();
const name = packageName();
rmSync(archiveRoot, { recursive: true, force: true });
mkdirSync(archiveRoot, { recursive: true });
runCommand("pnpm", ["pack", "--pack-destination", archiveRoot], packageDirectory());
const archive = archivePath(version);
const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
if (files.some((file) => !/^package\/(?:dist\/|package\.json$|README\.md$|LICENSE$|NOTICE$)/.test(file)))
  throw new Error(`${name}: unexpected published file`);
if (
  files.some(
    (file) =>
      /\/(?:test|fixtures|node_modules)\//.test(file) ||
      (/\.[cm]?ts$/.test(file) && !/\.d\.[cm]?ts$/.test(file))
  )
)
  throw new Error(`${name}: tests or TypeScript sources in archive`);
const packedManifestText = execFileSync("tar", ["-xOzf", archive, "package/package.json"], {
  encoding: "utf8",
});
let packedManifest: unknown;
try {
  // SAFETY: JSON.parse is untyped, and the schema decode below is the only reader.
  packedManifest = JSON.parse(packedManifestText) as unknown;
} catch (cause) {
  throw new Error(`${name}: packed package.json is not valid JSON`, { cause });
}
const manifest = Schema.decodeUnknownSync(PublishManifest)(packedManifest);
if (manifest.private === true || manifest.version !== version)
  throw new Error(`${name}: invalid publish manifest`);
const dependencies = manifest.dependencies ?? {};
for (const [dependency, specifier] of Object.entries(dependencies)) {
  if (/^(?:workspace|catalog|file|link):/.test(specifier))
    throw new Error(`${name}: unresolved dependency ${dependency}`);
  if (dependency.startsWith("@elmeragroup/"))
    throw new Error(`${name}: private workspace dependency ${dependency}`);
}
if (!dependencies.typescript || !dependencies.effect || !dependencies["@oxlint/plugins"])
  throw new Error(`${name}: external runtime dependency missing`);
if (
  !files.includes("package/dist/index.mjs") ||
  !files.includes("package/dist/index.d.mts") ||
  !files.includes("package/LICENSE")
)
  throw new Error(`${name}: missing entry or license`);
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
const actualExports = Object.keys(exports).sort();
const missingExports = expectedExports.filter((entry) => !actualExports.includes(entry));
const unexpectedExports = actualExports.filter((entry) => !expectedExports.includes(entry));
if (missingExports.length > 0 || unexpectedExports.length > 0)
  throw new Error(
    `${name}: unexpected public exports (missing: ${missingExports.join(", ") || "none"}; ` +
      `unexpected: ${unexpectedExports.join(", ") || "none"})`
  );
for (const [entry, conditions] of Object.entries(exports)) {
  for (const target of Object.values(conditions)) {
    if (!files.includes(`package/${target.slice(2)}`))
      throw new Error(`${name}: missing export target ${entry}`);
  }
}
if (manifest.sideEffects !== false) throw new Error(`${name}: unexpected sideEffects metadata`);
for (const file of files.filter((file) => /\.[cm]?[jt]s$/.test(file))) {
  const source = execFileSync("tar", ["-xOzf", archive, file], { encoding: "utf8" });
  if (/(?:from\s*|import\s*\(?)["']@elmeragroup\//.test(source))
    throw new Error(`${file}: unpublished workspace import`);
}
const notice = execFileSync("tar", ["-xOzf", archive, "package/NOTICE"]);
const expectedNotice = readFileSync(resolve(packageDirectory(), "NOTICE"));
if (!notice.equals(expectedNotice))
  throw new Error(`${name}: NOTICE does not match packages/internal/NOTICE`);
console.log(JSON.stringify({ version, archive }, null, 2));
