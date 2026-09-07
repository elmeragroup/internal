import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { readJsonObject } from "./lib/json-object.mjs";
import { assertCanaryReleaseVersion } from "./release-version.ts";
import { packageNames, repoRoot } from "./release.ts";

const version = process.argv[2];
if (version === undefined) throw new Error("Usage: pnpm canary:version x.y.z-canary.N");
assertCanaryReleaseVersion([version]);
for (const name of packageNames) {
  const file = resolve(repoRoot, "packages", name, "package.json");
  const manifest = readJsonObject(file);
  manifest.version = version;
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}
console.log(`Prepared ${version}. Run pnpm install --lockfile-only before packing.`);
