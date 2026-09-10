import { execFileSync } from "node:child_process";

import { asString, parseJsonObject } from "./lib/json-object.mjs";
import { assertStableReleaseFiles } from "./release-files.ts";
import { packageDirectory, packageManifest, releaseVersion, repoRoot } from "./release.ts";

const base = execFileSync("git", ["show", `origin/main:${packageManifest}`], {
  cwd: repoRoot,
  encoding: "utf8",
});
assertStableReleaseFiles(
  asString(parseJsonObject(base, "main manifest").version, "main version"),
  releaseVersion(),
  repoRoot,
  packageDirectory
);
