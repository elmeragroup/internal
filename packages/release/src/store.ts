import { Schema } from "effect";
import type { Effect } from "effect";

import { liftPromise } from "./errors.ts";
import type { ReleaseError } from "./errors.ts";
import { GitHubRelease, GitHubReleaseAsset, GitHubTagRef } from "./github.ts";
import type { GitHubClient } from "./github.ts";
import { releaseArchiveName, releaseTag, serializeIntent } from "./intent.ts";
import type { ReleaseIntent } from "./intent.ts";
import { classifyReleaseRecord } from "./ownership.ts";

export type ReleaseAsset = { state: "missing" } | { state: "starter" | "uploaded"; id: number };

export type SavedRelease = {
  id: number;
  intent: ReleaseIntent;
  asset: ReleaseAsset;
};

export type ReleaseStore = {
  find: (tag: string) => Effect.Effect<SavedRelease | undefined, ReleaseError>;
  create: (intent: ReleaseIntent) => Effect.Effect<SavedRelease, ReleaseError>;
  upload: (release: SavedRelease, bytes: Uint8Array) => Effect.Effect<SavedRelease, ReleaseError>;
  download: (release: SavedRelease) => Effect.Effect<Uint8Array, ReleaseError>;
  complete: (release: SavedRelease) => Effect.Effect<void, ReleaseError>;
  reservedCanaryVersions: () => Effect.Effect<string[], ReleaseError>;
};

type CatalogEntry =
  | { kind: "saved"; release: SavedRelease }
  | { kind: "foreign" }
  | { kind: "broken"; reason: string };
type ReleaseCatalog = Map<string, CatalogEntry>;

function assertSameIntent(saved: ReleaseIntent, intended: ReleaseIntent): void {
  if (
    saved.commit !== intended.commit ||
    saved.version !== intended.version ||
    saved.channel !== intended.channel
  )
    throw new Error("Release intent differs from the saved release");
}

function releaseBodyText(value: GitHubRelease): string {
  return value.body ?? "";
}

function assetNames(value: GitHubRelease): string[] {
  return value.assets.map((asset) => asset.name);
}

/** `starterAllowed` records that an empty placeholder is only legal on a draft release. */
export function classifyReleaseAsset(
  starterAllowed: boolean,
  asset: GitHubReleaseAsset | undefined
): ReleaseAsset {
  if (asset === undefined) return { state: "missing" };
  if (asset.state === "starter") {
    if (!starterAllowed || asset.size !== 0) throw new Error("Unsupported starter release asset");
    return { state: "starter", id: asset.id };
  }
  if (asset.state !== "uploaded") throw new Error(`Unsupported release asset state ${asset.state}`);
  if (asset.size <= 0) throw new Error("Uploaded release asset has no bytes");
  return { state: "uploaded", id: asset.id };
}

function savedReleaseFrom(value: GitHubRelease, intent: ReleaseIntent): SavedRelease {
  const assets = value.assets.filter((asset) => asset.name === releaseArchiveName);
  if (assets.length > 1) throw new Error("Duplicate release archives");
  return {
    id: value.id,
    intent,
    asset: classifyReleaseAsset(value.draft === true, assets[0]),
  };
}

/**
 * One record's catalog entry. Ignored tags produce no entry; a record this owner cannot read
 * becomes `broken` so one damaged release does not fail the whole catalog listing.
 */
function classifyCatalogEntry(value: GitHubRelease): CatalogEntry | undefined {
  try {
    const classification = classifyReleaseRecord(value.tag_name, releaseBodyText(value), assetNames(value));
    switch (classification.kind) {
      case "ignored":
        return undefined;
      case "foreign":
        return { kind: "foreign" };
      case "owned":
      case "legacy":
        return { kind: "saved", release: savedReleaseFrom(value, classification.intent) };
    }
  } catch (cause) {
    return {
      kind: "broken",
      reason: cause instanceof Error ? cause.message : "Unreadable release record",
    };
  }
}

/** Builds a saved release from a response that must be a readable record of this owner. */
function savedFromRecord(value: GitHubRelease): SavedRelease {
  const entry = classifyCatalogEntry(value);
  if (entry?.kind === "saved") return entry.release;
  if (entry?.kind === "broken") throw new Error(entry.reason);
  throw new Error("A foreign GitHub release occupies the record tag");
}

export function createReleaseStore(client: GitHubClient, packageName: string): ReleaseStore {
  const { root, request } = client;
  let catalog: ReleaseCatalog | undefined;

  async function readTagSha(tag: string): Promise<string | undefined> {
    const response = await request(`${root}/git/ref/tags/${encodeURIComponent(tag)}`, { allow404: true });
    if (response === undefined) return undefined;
    const { object } = await client.json(response, GitHubTagRef, "tag target");
    if (object.type !== "commit") {
      throw new Error("Release tag does not point at a commit");
    }
    return object.sha;
  }

  async function assertTagMatchesCommit(tag: string, saved: SavedRelease): Promise<void> {
    const sha = await readTagSha(tag);
    if (sha !== saved.intent.commit) throw new Error(`Release tag ${tag} was moved from the release commit`);
  }

  async function listReleases(): Promise<ReleaseCatalog> {
    const listed: ReleaseCatalog = new Map();
    for (let page = 1; ; page += 1) {
      const pageItems = await client.json(
        await request(`${root}/releases?per_page=100&page=${String(page)}`),
        Schema.Array(GitHubRelease),
        "GitHub releases"
      );
      for (const value of pageItems) {
        const entry = classifyCatalogEntry(value);
        if (entry !== undefined) listed.set(value.tag_name, entry);
      }
      if (pageItems.length < 100) break;
    }
    return listed;
  }

  // One listing per store instance; every later read and write goes through this same catalog.
  async function releaseCatalog(): Promise<ReleaseCatalog> {
    catalog ??= await listReleases();
    return catalog;
  }

  async function remember(saved: SavedRelease): Promise<void> {
    (await releaseCatalog()).set(releaseTag(saved.intent), { kind: "saved", release: saved });
  }

  async function find(tag: string): Promise<SavedRelease | undefined> {
    // Listing with push access includes drafts, unlike the published-release-by-tag endpoint.
    const entry = (await releaseCatalog()).get(tag);
    if (entry?.kind === "broken") {
      throw new Error(`Release record ${tag} is damaged: ${entry.reason}`);
    }
    if (entry?.kind === "foreign") {
      throw new Error(`A foreign GitHub release occupies release record ${tag}`);
    }
    if (entry?.kind === "saved") {
      await assertTagMatchesCommit(tag, entry.release);
      return entry.release;
    }
    return undefined;
  }

  async function readSaved(id: number): Promise<SavedRelease> {
    const value = await client.jsonFrom(`${root}/releases/${String(id)}`, GitHubRelease, "GitHub release");
    const saved = savedFromRecord(value);
    await assertTagMatchesCommit(releaseTag(saved.intent), saved);
    await remember(saved);
    return saved;
  }

  async function create(intent: ReleaseIntent): Promise<SavedRelease> {
    const tag = releaseTag(intent);
    const existing = await find(tag);
    if (existing !== undefined) {
      assertSameIntent(existing.intent, intent);
      return existing;
    }
    const sha = await readTagSha(tag);
    if (sha === undefined) {
      await client.json(
        await request(`${root}/git/refs`, {
          method: "POST",
          body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: intent.commit }),
        }),
        GitHubTagRef,
        "created tag"
      );
    } else if (sha !== intent.commit) {
      throw new Error(`Existing release tag ${tag} points to a different commit`);
    }
    const value = await client.json(
      await request(`${root}/releases`, {
        method: "POST",
        body: JSON.stringify({
          tag_name: tag,
          target_commitish: intent.commit,
          name: `${packageName} ${intent.version}`,
          body: serializeIntent(intent),
          draft: true,
          prerelease: intent.channel === "canary",
        }),
      }),
      GitHubRelease,
      "GitHub release"
    );
    const created = savedFromRecord(value);
    assertSameIntent(created.intent, intent);
    await remember(created);
    return created;
  }

  async function upload(release: SavedRelease, bytes: Uint8Array): Promise<SavedRelease> {
    // Revalidate the intent and current asset before repairing an interrupted preparation.
    // `readSaved` has already re-checked that the record tag still points at the release commit.
    const current = await readSaved(release.id);
    assertSameIntent(current.intent, release.intent);
    if (current.asset.state === "uploaded") throw new Error("A recorded release archive cannot be replaced");
    if (current.asset.state === "starter") {
      await request(`${root}/releases/assets/${String(current.asset.id)}`, { method: "DELETE" });
    }
    const uploadedAsset = await client.json(
      await request(`${client.uploadRoot}/releases/${String(release.id)}/assets?name=${releaseArchiveName}`, {
        method: "POST",
        body: new Blob([new Uint8Array(bytes)]),
      }),
      GitHubReleaseAsset,
      "uploaded asset"
    );
    const uploaded: SavedRelease = {
      id: release.id,
      intent: current.intent,
      asset: classifyReleaseAsset(false, uploadedAsset),
    };
    await remember(uploaded);
    return uploaded;
  }

  async function download(release: SavedRelease): Promise<Uint8Array> {
    if (release.asset.state !== "uploaded")
      throw new Error(
        "Release preparation is incomplete; rerun its original Merge job before retrying publication"
      );
    const response = await request(`${root}/releases/assets/${String(release.asset.id)}`, {
      accept: "application/octet-stream",
    });
    return new Uint8Array(await response.arrayBuffer());
  }

  async function complete(release: SavedRelease): Promise<void> {
    if (release.asset.state !== "uploaded")
      throw new Error("A release record cannot be published without its verified archive");
    await client.json(
      await request(`${root}/releases/${String(release.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ draft: false, make_latest: "false" }),
      }),
      GitHubRelease,
      "GitHub release"
    );
  }

  async function reservedCanaryVersions(): Promise<string[]> {
    const versions: string[] = [];
    for (const entry of (await releaseCatalog()).values()) {
      if (entry.kind === "saved" && entry.release.intent.channel === "canary") {
        versions.push(entry.release.intent.version);
      }
    }
    return versions;
  }

  return {
    find: (tag) => liftPromise(() => find(tag)),
    create: (intent) => liftPromise(() => create(intent)),
    upload: (release, bytes) => liftPromise(() => upload(release, bytes)),
    download: (release) => liftPromise(() => download(release)),
    complete: (release) => liftPromise(() => complete(release)),
    reservedCanaryVersions: () => liftPromise(() => reservedCanaryVersions()),
  };
}
