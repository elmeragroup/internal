import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { runCommand } from "../packages/release/src/index.ts";
import { asRecord, asString, readJsonObject } from "./lib/json-object.mjs";
import { archiveDirectory, archivePath, packageDirectory, packageName, releaseVersion } from "./release.ts";

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
const manifestFile = resolve(archiveDirectory, "internal.json");
writeFileSync(manifestFile, execFileSync("tar", ["-xOzf", archive, "package/package.json"]));
const manifest = readJsonObject(manifestFile);
if (manifest.private === true || manifest.version !== version)
  throw new Error(`${packageName}: invalid publish manifest`);
const dependencies = asRecord(manifest.dependencies, "dependencies");
for (const [dependency, value] of Object.entries(dependencies)) {
  const specifier = asString(value, dependency);
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
const exports = asRecord(manifest.exports, "exports");
if (JSON.stringify(Object.keys(exports)) !== JSON.stringify(expectedExports))
  throw new Error(`${packageName}: unexpected public exports`);
for (const [entry, conditions] of Object.entries(exports)) {
  for (const target of Object.values(asRecord(conditions, entry))) {
    if (!files.includes(`package/${asString(target, entry).slice(2)}`))
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
const packedArchive = {
  name: asString(manifest.name, "name"),
  archive,
  bytes: readFileSync(archive).length,
  sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
};
writeFileSync(
  resolve(archiveDirectory, "archive.json"),
  `${JSON.stringify({ version, archive: packedArchive }, null, 2)}\n`
);
console.log(JSON.stringify({ version, archive: packedArchive }, null, 2));
