import { Schema } from "effect";
import type { Effect } from "effect";
import { spawnSync } from "node:child_process";

import { lift, liftPromise } from "./errors.ts";
import type { ReleaseError } from "./errors.ts";
import type { ReleasePackage } from "./files.ts";
import { decodeJson } from "./json.ts";

export type PublishedVersion = {
  integrity?: string;
  commit?: string;
};

export type Registry = {
  versions: Map<string, PublishedVersion>;
  tags: Map<string, string>;
};

/** Publishes the archive to the staging tag, then moves the installable dist-tag. */
export type NpmPublisher = {
  publish: (archive: string) => Effect.Effect<void, ReleaseError>;
  promote: (version: string, tag: string) => Effect.Effect<void, ReleaseError>;
};

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

async function fetchRegistry(packageName: string, fetcher: typeof fetch): Promise<Registry> {
  const response = await fetcher(registryUrl(packageName), { signal: AbortSignal.timeout(30_000) });
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

/** Live npm CLI port for one package. Publications publish to `pending`; promotion moves the tag. */
export function createNpmPublisher(pkg: ReleasePackage): NpmPublisher {
  function runNpm(args: readonly string[]): Effect.Effect<void, ReleaseError> {
    return lift("publication", () => {
      const result = spawnSync("npm", args, { cwd: pkg.checkoutRoot, stdio: "inherit" });
      if (result.error !== undefined) throw result.error;
      if (result.status !== 0) throw new Error(`npm failed with status ${String(result.status)}`);
    });
  }
  return {
    publish: (archive) =>
      runNpm(["publish", archive, "--access", "public", "--tag", "pending", "--ignore-scripts"]),
    promote: (version, tag) => runNpm(["dist-tag", "add", `${pkg.packageName}@${version}`, tag]),
  };
}

export function readRegistry(
  packageName: string,
  fetcher: typeof fetch
): Effect.Effect<Registry, ReleaseError> {
  return liftPromise("registry", () => fetchRegistry(packageName, fetcher));
}
