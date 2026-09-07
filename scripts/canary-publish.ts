import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { asRecord, asString, readJsonObject } from "./lib/json-object.mjs";
import { archiveDirectory, archivePath, canaryVersion, packageName, run } from "./release.ts";

const version = canaryVersion();
const report = readJsonObject(resolve(archiveDirectory, "archive.json"));
const verification = readJsonObject(resolve(archiveDirectory, "verified.json"));
const expected = asRecord(report.archive, "archive");
if (
  verification.status !== "pass" ||
  report.version !== version ||
  verification.version !== version ||
  verification.archiveReportSha256 !==
    createHash("sha256")
      .update(readFileSync(resolve(archiveDirectory, "archive.json")))
      .digest("hex")
)
  throw new Error("Packed consumer verification does not match this archive");
const archive = archivePath(version);
if (
  expected.name !== packageName ||
  asString(expected.sha256, "sha256") !== createHash("sha256").update(readFileSync(archive)).digest("hex")
)
  throw new Error(`${packageName}: archive changed since verification`);
run("npm", ["publish", archive, "--access", "public", "--tag", "canary", "--ignore-scripts"]);
