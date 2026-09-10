import { Schema } from "effect";

import { decodeJson } from "./json.ts";
import type { PublishedVersion, Registry } from "./registry.ts";

export type { PublishedVersion, Registry };

const ReleaseSource = Schema.Struct({
  commit: Schema.String,
});

const NpmVersion = Schema.Struct({
  dist: Schema.Struct({
    integrity: Schema.optionalKey(Schema.String),
  }),
  elmeraRelease: Schema.optionalKey(ReleaseSource),
  gitHead: Schema.optionalKey(Schema.String),
});

const NpmPackument = Schema.Struct({
  versions: Schema.Record(Schema.String, NpmVersion),
  "dist-tags": Schema.Record(Schema.String, Schema.String),
});

function registryUrl(packageName: string): string {
  return `https://registry.npmjs.org/${packageName.replace("/", "%2f")}`;
}

function publishedCommit(manifest: typeof NpmVersion.Type): string | undefined {
  if (manifest.elmeraRelease === undefined) {
    return manifest.gitHead !== undefined && /^[a-f0-9]{40}$/.test(manifest.gitHead)
      ? manifest.gitHead
      : undefined;
  }
  return manifest.elmeraRelease.commit;
}

export async function readRegistry(packageName: string, request: typeof fetch = fetch): Promise<Registry> {
  const response = await request(registryUrl(packageName), { signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return { versions: new Map(), tags: new Map() };
  if (!response.ok) throw new Error(`npm registry lookup failed: ${String(response.status)}`);
  const data = decodeJson(await response.text(), NpmPackument, "npm registry");
  const versions = new Map<string, PublishedVersion>();
  for (const [version, manifest] of Object.entries(data.versions)) {
    versions.set(version, {
      integrity: manifest.dist.integrity,
      commit: publishedCommit(manifest),
    });
  }
  return { versions, tags: new Map(Object.entries(data["dist-tags"])) };
}
