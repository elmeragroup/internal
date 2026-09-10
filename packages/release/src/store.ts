import { createGitHubClient } from "./github.ts";
import type { GitHubClient, GitHubRelease, GitHubReleaseAsset } from "./github.ts";
import {
  decodeGitHubRelease,
  decodeGitHubTagRef,
  GitHubReleaseAsset as GitHubReleaseAssetSchema,
} from "./github.ts";
import { releaseTag, serializeIntent, verifiedBundleName } from "./intent.ts";
import type { ReleaseIntent } from "./intent.ts";
import { decodeUnknown, isJsonString } from "./json.ts";
import { classifyReleaseRecord } from "./ownership.ts";

export type ReleaseAsset = { state: "missing" } | { state: "starter" | "uploaded"; id: number };

export type SavedRelease = {
  id: number;
  intent: ReleaseIntent;
  asset: ReleaseAsset;
};

export type ReleaseStore = {
  find: (tag: string) => Promise<SavedRelease | undefined>;
  create: (intent: ReleaseIntent) => Promise<SavedRelease>;
  upload: (release: SavedRelease, bytes: Uint8Array) => Promise<SavedRelease>;
  download: (release: SavedRelease) => Promise<Uint8Array>;
  complete: (release: SavedRelease) => Promise<void>;
  reservedCanaryVersions: () => Promise<string[]>;
};

export type ReleaseAssetFields = {
  id: number;
  state: string;
  size: number;
};

type CatalogEntry = { kind: "saved"; release: SavedRelease } | { kind: "foreign" };
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
  if (value.body === null || value.body === undefined) return "";
  if (!isJsonString(value.body)) throw new Error("release body is not a string");
  return value.body;
}

function assetNames(value: GitHubRelease): string[] {
  return value.assets.map((asset) => asset.name);
}

function recordIntent(value: GitHubRelease): ReleaseIntent {
  const classification = classifyReleaseRecord(value.tag_name, releaseBodyText(value), assetNames(value));
  switch (classification.kind) {
    case "owned":
    case "legacy":
      return classification.intent;
    case "foreign":
    case "ignored":
      throw new Error("A foreign GitHub release occupies the record tag");
  }
}

/** `starterAllowed` records that an empty placeholder is only legal on a draft release. */
export function classifyReleaseAsset(
  starterAllowed: boolean,
  asset: ReleaseAssetFields | undefined
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

function assetFields(asset: GitHubReleaseAsset): ReleaseAssetFields {
  return { id: asset.id, state: asset.state, size: asset.size };
}

function savedReleaseFrom(value: GitHubRelease, intent: ReleaseIntent): SavedRelease {
  const assets = value.assets.filter((asset) => asset.name === verifiedBundleName);
  if (assets.length > 1) throw new Error("Duplicate release archives");
  const raw = assets[0];
  return {
    id: value.id,
    intent,
    asset: classifyReleaseAsset(value.draft === true, raw === undefined ? undefined : assetFields(raw)),
  };
}

export function createReleaseStore(client: GitHubClient, packageName: string): ReleaseStore {
  const { root, request, data } = client;
  let catalog: ReleaseCatalog | undefined;

  async function readTagSha(tag: string): Promise<string | undefined> {
    const response = await request(`${root}/git/ref/tags/${encodeURIComponent(tag)}`, { allow404: true });
    if (response === undefined) return undefined;
    const object = decodeGitHubTagRef(await data(response), "tag target").object;
    if (object.type !== "commit") {
      throw new Error("Release tag was moved or is not a direct commit reference");
    }
    return object.sha;
  }

  async function assertTagMatchesCommit(saved: SavedRelease): Promise<void> {
    const sha = await readTagSha(releaseTag(saved.intent));
    if (sha !== saved.intent.commit)
      throw new Error("Release tag was moved or is not a direct commit reference");
  }

  async function listReleases(): Promise<ReleaseCatalog> {
    const listed: ReleaseCatalog = new Map();
    for (let page = 1; ; page += 1) {
      const pageItems = await client.items(
        await request(`${root}/releases?per_page=100&page=${String(page)}`),
        "GitHub releases"
      );
      for (const item of pageItems) {
        const value = decodeGitHubRelease(item, "GitHub release");
        const classification = classifyReleaseRecord(
          value.tag_name,
          releaseBodyText(value),
          assetNames(value)
        );
        switch (classification.kind) {
          case "ignored":
            break;
          case "foreign":
            listed.set(value.tag_name, { kind: "foreign" });
            break;
          case "owned":
          case "legacy":
            listed.set(value.tag_name, {
              kind: "saved",
              release: savedReleaseFrom(value, classification.intent),
            });
            break;
        }
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
    if (entry?.kind === "foreign") {
      throw new Error("A foreign GitHub release occupies the record tag");
    }
    if (entry?.kind === "saved") {
      await assertTagMatchesCommit(entry.release);
      return entry.release;
    }
    return undefined;
  }

  async function readSaved(id: number): Promise<SavedRelease> {
    const value = decodeGitHubRelease(
      await data(await request(`${root}/releases/${String(id)}`)),
      "GitHub release"
    );
    const saved = savedReleaseFrom(value, recordIntent(value));
    await assertTagMatchesCommit(saved);
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
      await data(
        await request(`${root}/git/refs`, {
          method: "POST",
          body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: intent.commit }),
        })
      );
    } else if (sha !== intent.commit) {
      throw new Error("Existing release tag points to a different commit");
    }
    const value = decodeGitHubRelease(
      await data(
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
        })
      ),
      "GitHub release"
    );
    const created = savedReleaseFrom(value, recordIntent(value));
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
    const uploadedAsset = decodeUnknown(
      await data(
        await request(
          `${client.uploadRoot}/releases/${String(release.id)}/assets?name=${verifiedBundleName}`,
          {
            method: "POST",
            body: new Blob([new Uint8Array(bytes)]),
          }
        )
      ),
      GitHubReleaseAssetSchema,
      "uploaded asset"
    );
    const uploaded: SavedRelease = {
      id: release.id,
      intent: current.intent,
      asset: classifyReleaseAsset(false, assetFields(uploadedAsset)),
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
    await data(
      await request(`${root}/releases/${String(release.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ draft: false, make_latest: "false" }),
      })
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

  return { find, create, upload, download, complete, reservedCanaryVersions };
}

export function githubClientFromEnv(
  repository = process.env.GITHUB_REPOSITORY ?? "",
  token = process.env.GH_TOKEN ?? ""
): GitHubClient {
  return createGitHubClient(repository, token);
}
