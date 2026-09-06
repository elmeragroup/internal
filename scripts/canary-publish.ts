import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { asRecordArray, asString, readJsonObject } from "./lib/json-object.mjs";
import { archiveDirectory, archivePath, canaryVersion, packageNames, run } from "./release.ts";

const version = canaryVersion();
const report = readJsonObject(resolve(archiveDirectory, "archives.json"));
const verification = readJsonObject(resolve(archiveDirectory, "verified.json"));
const archives = asRecordArray(report.archives, "archives");
if (
  report.version !== version ||
  verification.version !== version ||
  verification.archivesSha256 !==
    createHash("sha256")
      .update(readFileSync(resolve(archiveDirectory, "archives.json")))
      .digest("hex")
)
  throw new Error("Packed consumer verification does not match these archives");
for (const name of packageNames) {
  const archive = archivePath(name, version);
  const expected = archives.find((entry) => entry.name === `@elmeragroup/${name}`);
  if (
    expected === undefined ||
    asString(expected.sha256, "sha256") !== createHash("sha256").update(readFileSync(archive)).digest("hex")
  )
    throw new Error(`${name}: archive changed since verification`);
}
for (const name of packageNames)
  run("npm", [
    "publish",
    archivePath(name, version),
    "--access",
    "public",
    "--tag",
    "canary",
    "--ignore-scripts",
  ]);
