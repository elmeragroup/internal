import type { PublishedVersion, Registry } from "../packages/release/src/registry.ts";
import { asRecord, asString, isString, parseJsonObject } from "./lib/json-object.mjs";

export type { PublishedVersion, Registry };

function registryUrl(packageName: string): string {
  return `https://registry.npmjs.org/${packageName.replace("/", "%2f")}`;
}

export async function readRegistry(packageName: string, request: typeof fetch = fetch): Promise<Registry> {
  const response = await request(registryUrl(packageName), { signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return { versions: new Map(), tags: new Map() };
  if (!response.ok) throw new Error(`npm registry lookup failed: ${String(response.status)}`);
  const data = parseJsonObject(await response.text(), "npm registry");
  const versions = new Map<string, PublishedVersion>();
  for (const [version, value] of Object.entries(asRecord(data.versions, "npm versions"))) {
    const manifest = asRecord(value, version);
    const dist = asRecord(manifest.dist, "npm dist");
    const source =
      manifest.elmeraRelease === undefined ? undefined : asRecord(manifest.elmeraRelease, "release source");
    versions.set(version, {
      integrity: isString(dist.integrity) ? dist.integrity : undefined,
      commit:
        source === undefined
          ? isString(manifest.gitHead) && /^[a-f0-9]{40}$/.test(manifest.gitHead)
            ? manifest.gitHead
            : undefined
          : asString(source.commit, "source commit"),
    });
  }
  const tags = new Map<string, string>();
  for (const [tag, version] of Object.entries(asRecord(data["dist-tags"], "npm tags"))) {
    tags.set(tag, asString(version, tag));
  }
  return { versions, tags };
}
