import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { asRecord, asString, readJsonObject } from "./lib/json-object.mjs";
import { archiveDirectory, archivePath, canaryVersion, packageNames, repoRoot, run } from "./release.ts";

const version = canaryVersion();
rmSync(archiveDirectory, { recursive: true, force: true });
mkdirSync(archiveDirectory, { recursive: true });
const archives = [];
for (const name of packageNames) {
  run("pnpm", ["pack", "--pack-destination", archiveDirectory], resolve(repoRoot, "packages", name));
  const archive = archivePath(name, version);
  const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
  if (files.some((file) => !/^package\/(?:dist\/|package\.json$|README\.md$|LICENSE$|NOTICE$)/.test(file)))
    throw new Error(`${name}: unexpected published file`);
  if (
    files.some(
      (file) =>
        /\/(?:test|fixtures|node_modules)\//.test(file) || (file.endsWith(".ts") && !file.endsWith(".d.ts"))
    )
  )
    throw new Error(`${name}: tests or TypeScript sources in archive`);
  const manifestFile = resolve(archiveDirectory, `${name}.json`);
  writeFileSync(manifestFile, execFileSync("tar", ["-xOzf", archive, "package/package.json"]));
  const manifest = readJsonObject(manifestFile);
  if (manifest.private === true || manifest.version !== version)
    throw new Error(`${name}: invalid publish manifest`);
  const dependencies = asRecord(manifest.dependencies, "dependencies");
  for (const [dependency, value] of Object.entries(dependencies)) {
    const specifier = asString(value, dependency);
    if (/^(?:workspace|catalog|file|link):/.test(specifier))
      throw new Error(`${name}: unresolved dependency ${dependency}`);
    if (dependency.startsWith("@elmeragroup/") && specifier !== version)
      throw new Error(`${name}: canary dependency version mismatch`);
  }
  if (name !== "internal" && !dependencies.typescript) throw new Error(`${name}: TypeScript runtime missing`);
  if (
    !files.includes("package/dist/index.js") ||
    !files.includes("package/dist/index.d.ts") ||
    !files.includes("package/LICENSE")
  )
    throw new Error(`${name}: missing entry or license`);
  archives.push({
    name: asString(manifest.name, "name"),
    archive,
    bytes: readFileSync(archive).length,
    sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
  });
}
writeFileSync(
  resolve(archiveDirectory, "archives.json"),
  `${JSON.stringify({ version, archives }, null, 2)}\n`
);
console.log(JSON.stringify({ version, archives }, null, 2));
