import { asInteger, asRecord, asRecordArray, asString, isString } from "./lib/json-object.mjs";
import type { GitHubClient, GitHubObject } from "./release-github-client.ts";
import { isReleaseTag, parseIntent, releaseTag, verifiedBundleName } from "./release-record.ts";
import type { ReleaseIntent } from "./release-record.ts";

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

function assertSameIntent(saved: ReleaseIntent, intended: ReleaseIntent): void {
  if (
    saved.commit !== intended.commit ||
    saved.version !== intended.version ||
    saved.channel !== intended.channel
  )
    throw new Error("Release intent differs from the saved release");
}

function intentForRelease(value: GitHubObject): ReleaseIntent {
  const tag = asString(value.tag_name, "release tag");
  const intent = parseIntent(asString(value.body, "release body"));
  if (releaseTag(intent) !== tag) throw new Error("Release tag does not match its intent");
  return intent;
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

function assetFields(value: GitHubObject): ReleaseAssetFields {
  return {
    id: asInteger(value.id, "asset id"),
    state: asString(value.state, "asset state"),
    size: asInteger(value.size, "asset size"),
  };
}

function savedReleaseFrom(value: GitHubObject): SavedRelease {
  const assets = asRecordArray(value.assets, "release assets").filter(
    (asset) => asset.name === verifiedBundleName
  );
  if (assets.length > 1) throw new Error("Duplicate release archives");
  const raw = assets[0];
  return {
    id: asInteger(value.id, "release id"),
    intent: intentForRelease(value),
    asset: classifyReleaseAsset(value.draft === true, raw === undefined ? undefined : assetFields(raw)),
  };
}

export function createReleaseStore(client: GitHubClient): ReleaseStore {
  const { root, request, data } = client;
  let catalog: Map<string, SavedRelease> | undefined;

  async function readTagSha(tag: string): Promise<string | undefined> {
    const response = await request(`${root}/git/ref/tags/${encodeURIComponent(tag)}`, { allow404: true });
    if (response === undefined) return undefined;
    const object = asRecord((await data(response)).object, "tag target");
    if (object.type !== "commit" || !isString(object.sha)) {
      throw new Error("Release tag was moved or is not a direct commit reference");
    }
    return object.sha;
  }

  async function assertTagMatchesCommit(saved: SavedRelease): Promise<void> {
    const sha = await readTagSha(releaseTag(saved.intent));
    if (sha !== saved.intent.commit)
      throw new Error("Release tag was moved or is not a direct commit reference");
  }

  async function listReleases(): Promise<Map<string, SavedRelease>> {
    const items = new Map<string, SavedRelease>();
    for (let page = 1; ; page += 1) {
      const pageItems = await client.items(
        await request(`${root}/releases?per_page=100&page=${String(page)}`),
        "GitHub releases"
      );
      for (const value of pageItems) {
        const tag = asString(value.tag_name, "release tag");
        if (!isReleaseTag(tag)) continue;
        items.set(tag, savedReleaseFrom(value));
      }
      if (pageItems.length < 100) break;
    }
    return items;
  }

  // One listing per store instance; every later read and write goes through this same catalog.
  async function releaseCatalog(): Promise<Map<string, SavedRelease>> {
    catalog ??= await listReleases();
    return catalog;
  }

  async function remember(saved: SavedRelease): Promise<void> {
    (await releaseCatalog()).set(releaseTag(saved.intent), saved);
  }

  async function find(tag: string): Promise<SavedRelease | undefined> {
    // Listing with push access includes drafts, unlike the published-release-by-tag endpoint.
    const saved = (await releaseCatalog()).get(tag);
    if (saved === undefined) return undefined;
    await assertTagMatchesCommit(saved);
    return saved;
  }

  async function readSaved(id: number): Promise<SavedRelease> {
    const saved = savedReleaseFrom(await data(await request(`${root}/releases/${String(id)}`)));
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
    const created = savedReleaseFrom(
      await data(
        await request(`${root}/releases`, {
          method: "POST",
          body: JSON.stringify({
            tag_name: tag,
            target_commitish: intent.commit,
            name: `@elmeragroup/internal ${intent.version}`,
            body: JSON.stringify({ schema: 1, ...intent }),
            draft: true,
            prerelease: intent.channel === "canary",
          }),
        })
      )
    );
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
    const value = await data(
      await request(`${client.uploadRoot}/releases/${String(release.id)}/assets?name=${verifiedBundleName}`, {
        method: "POST",
        body: new Blob([new Uint8Array(bytes)]),
      })
    );
    const uploaded: SavedRelease = {
      id: release.id,
      intent: current.intent,
      asset: classifyReleaseAsset(false, assetFields(value)),
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
    for (const saved of (await releaseCatalog()).values()) {
      if (saved.intent.channel === "canary") versions.push(saved.intent.version);
    }
    return versions;
  }

  return { find, create, upload, download, complete, reservedCanaryVersions };
}
