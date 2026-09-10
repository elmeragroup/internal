import { Schema } from "effect";

import { decodeJson, decodeUnknown, isJsonString } from "./json.ts";
import type { PublishedVersion, Registry } from "./registry.ts";

export type { PublishedVersion, Registry };

const NpmVersion = Schema.Struct({
  dist: Schema.Struct({
    integrity: Schema.optionalKey(Schema.Json),
  }),
  elmeraRelease: Schema.optionalKey(Schema.Json),
  gitHead: Schema.optionalKey(Schema.Json),
});

const NpmPackument = Schema.Struct({
  versions: Schema.Record(Schema.String, Schema.Json),
  "dist-tags": Schema.Record(Schema.String, Schema.Json),
});

const ReleaseSource = Schema.Struct({
  commit: Schema.String,
});

function registryUrl(packageName: string): string {
  return `https://registry.npmjs.org/${packageName.replace("/", "%2f")}`;
}

function publishedCommit(manifest: typeof NpmVersion.Type): string | undefined {
  if (manifest.elmeraRelease === undefined) {
    return isJsonString(manifest.gitHead) && /^[a-f0-9]{40}$/.test(manifest.gitHead)
      ? manifest.gitHead
      : undefined;
  }
  return decodeUnknown(manifest.elmeraRelease, ReleaseSource, "release source").commit;
}

export async function readRegistry(packageName: string, request: typeof fetch = fetch): Promise<Registry> {
  const response = await request(registryUrl(packageName), { signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return { versions: new Map(), tags: new Map() };
  if (!response.ok) throw new Error(`npm registry lookup failed: ${String(response.status)}`);
  const data = decodeJson(await response.text(), NpmPackument, "npm registry");
  const versions = new Map<string, PublishedVersion>();
  for (const [version, value] of Object.entries(data.versions)) {
    const manifest = decodeUnknown(value, NpmVersion, version);
    versions.set(version, {
      integrity: isJsonString(manifest.dist.integrity) ? manifest.dist.integrity : undefined,
      commit: publishedCommit(manifest),
    });
  }
  const tags = new Map<string, string>();
  for (const [tag, version] of Object.entries(data["dist-tags"])) {
    if (!isJsonString(version)) throw new Error(`${tag} is not a string`);
    tags.set(tag, version);
  }
  return { versions, tags };
}
