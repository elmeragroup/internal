import { writeFileSync } from "node:fs";

import { assertCanaryReleaseVersion } from "@elmeragroup/release";

import { readJsonObject } from "./lib/json-object.mjs";
import { manifestPath } from "./release.ts";

const version = process.argv[2];
if (version === undefined) throw new Error("Usage: pnpm canary:version x.y.z-canary.N");
assertCanaryReleaseVersion(version);
const manifest = readJsonObject(manifestPath);
manifest.version = version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Prepared ${version}. Run pnpm install --lockfile-only before packing.`);
