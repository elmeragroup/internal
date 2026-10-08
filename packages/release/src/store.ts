import { Effect, Schema } from "effect";
import type { Scope } from "effect";

import { verifyReleaseArchive } from "./archive.ts";
import type { PackAndVerify } from "./archive.ts";
import { lift, liftPromise, ReleaseError } from "./errors.ts";
import { GitHubRelease, GitHubReleaseAsset, GitHubTagRef, releaseId } from "./github.ts";
import type { GitHubClient, ReleaseAssetId, ReleaseId } from "./github.ts";
import type { CanaryIntent, CommitSha, ReleaseIntent, VerifiedRelease } from "./intent.ts";
import {
  assertReleaseTag,
  canaryRecordTag,
  classifyReleaseAsset,
  classifyReleaseRecord,
  releaseArchiveName,
  releaseTag,
  serializeIntent,
} from "./record.ts";
import type { ReleaseAsset } from "./record.ts";
import type { CanaryVersion } from "./version.ts";

/** A record as GitHub holds it: its release identity, parsed intent, and archive asset state. */
type StoredRecord = {
  id: ReleaseId;
  intent: ReleaseIntent;
  asset: ReleaseAsset;
};

/** A stored record whose recorded archive is attached. */
type AttachedRecord = StoredRecord & { asset: { state: "uploaded"; id: ReleaseAssetId } };

const incompletePreparation =
  "Release preparation is incomplete; rerun its original Merge job before retrying publication";

/**
 * A record whose recorded archive is attached and whose bytes were verified against its intent in
 * this operation's scope. The class is exported only as a type and its release id is an ES private
 * field, so only this module can construct one and neither an object literal nor a spread copy is
 * one: only a prepared record can be completed. The archive path in `release` lives as long as
 * that scope.
 */
class PreparedRecord {
  /** The release intent the record holds. */
  readonly intent: ReleaseIntent;
  /** The recorded archive, materialized and verified against `intent`, ready to publish. */
  readonly release: VerifiedRelease;
  /** The record tag, for messages. */
  readonly tag: string;
  readonly #releaseId: ReleaseId;

  constructor(record: AttachedRecord, release: VerifiedRelease) {
    this.intent = record.intent;
    this.release = release;
    this.tag = releaseTag(record.intent);
    this.#releaseId = record.id;
  }

  /** The GitHub release a prepared record completes; reachable only inside this module. */
  static releaseIdOf(record: PreparedRecord): ReleaseId {
    return record.#releaseId;
  }
}

export type { PreparedRecord };

/**
 * The Record store: the single owner of the record lifecycle. It reserves a record for a release
 * intent, attaches or restores the recorded archive, and completes the record after publication.
 * A damaged or foreign occupant of a requested record tag fails without mutation.
 */
export type RecordStore = {
  /** The canary release intent already recorded for `commit`, or `undefined` when none is. */
  recordedCanaryIntent: (commit: CommitSha) => Effect.Effect<CanaryIntent | undefined, ReleaseError>;
  /** Every canary version a readable record reserves, published or not. */
  reservedCanaryVersions: () => Effect.Effect<readonly CanaryVersion[], ReleaseError>;
  /**
   * Reserves the record for `intent` (idempotently) and returns it prepared. An attached recorded
   * archive is restored and verified; otherwise `adapter` packs exactly once and the bytes are
   * verified before they are attached. An attached archive is never replaced.
   */
  prepare: (
    intent: ReleaseIntent,
    adapter: PackAndVerify
  ) => Effect.Effect<PreparedRecord, ReleaseError, Scope.Scope>;
  /**
   * Restores the prepared record for a user-supplied record tag from its recorded archive. Fails
   * for a non-record tag, a tag with no record, and an incomplete record. Never packs.
   */
  restore: (recordTag: string) => Effect.Effect<PreparedRecord, ReleaseError, Scope.Scope>;
  /** Completes a prepared record once its release reached npm by publishing the GitHub release. */
  complete: (record: PreparedRecord) => Effect.Effect<void, ReleaseError>;
};

type CatalogEntry =
  | { kind: "record"; record: StoredRecord }
  | { kind: "foreign" }
  | { kind: "broken"; reason: string };
type ReleaseCatalog = Map<string, CatalogEntry>;

function assertSameIntent(recorded: ReleaseIntent, intended: ReleaseIntent): void {
  if (
    recorded.commit !== intended.commit ||
    recorded.version !== intended.version ||
    recorded.channel !== intended.channel
  )
    throw new Error("Release intent differs from the saved release");
}

function isAttached(record: StoredRecord): record is AttachedRecord {
  return record.asset.state === "uploaded";
}

/** Narrows a recorded canary's intent; a canary record tag only ever matches a canary intent. */
function canaryIntentOf(intent: ReleaseIntent): CanaryIntent {
  if (intent.channel !== "canary") throw new Error("A canary record tag holds a stable release intent");
  return intent;
}

function storedRecordFrom(value: GitHubRelease, intent: ReleaseIntent): StoredRecord {
  const assets = value.assets.filter((asset) => asset.name === releaseArchiveName);
  if (assets.length > 1) throw new Error("Duplicate release archives");
  return {
    id: releaseId(value.id),
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
    const classification = classifyReleaseRecord(
      value.tag_name,
      value.body ?? "",
      value.assets.map((asset) => asset.name)
    );
    switch (classification.kind) {
      case "ignored":
        return undefined;
      case "foreign":
        return { kind: "foreign" };
      case "owned":
      case "legacy":
        return { kind: "record", record: storedRecordFrom(value, classification.intent) };
    }
  } catch (cause) {
    return {
      kind: "broken",
      reason: cause instanceof Error ? cause.message : "Unreadable release record",
    };
  }
}

/** Builds a stored record from a response that must be a readable record of this owner. */
function storedRecordFromResponse(value: GitHubRelease): StoredRecord {
  const entry = classifyCatalogEntry(value);
  if (entry?.kind === "record") return entry.record;
  if (entry?.kind === "broken") throw new Error(entry.reason);
  throw new Error("A foreign GitHub release occupies the record tag");
}

/**
 * Builds the Record store for one package over GitHub draft releases (ADR 0005). The first read
 * lists every release page once and caches the catalog for the life of the store, so later reads
 * and writes see one consistent view.
 */
export function createRecordStore(client: GitHubClient, packageName: string): RecordStore {
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

  async function assertTagMatchesCommit(tag: string, record: StoredRecord): Promise<void> {
    const sha = await readTagSha(tag);
    if (sha !== record.intent.commit) throw new Error(`Release tag ${tag} was moved from the release commit`);
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

  async function remember(record: StoredRecord): Promise<void> {
    (await releaseCatalog()).set(releaseTag(record.intent), { kind: "record", record });
  }

  async function find(tag: string): Promise<StoredRecord | undefined> {
    // Listing with push access includes drafts, unlike the published-release-by-tag endpoint.
    const entry = (await releaseCatalog()).get(tag);
    if (entry?.kind === "broken") {
      throw new Error(`Release record ${tag} is damaged: ${entry.reason}`);
    }
    if (entry?.kind === "foreign") {
      throw new Error(`A foreign GitHub release occupies release record ${tag}`);
    }
    if (entry?.kind === "record") {
      await assertTagMatchesCommit(tag, entry.record);
      return entry.record;
    }
    return undefined;
  }

  async function readRecord(id: ReleaseId): Promise<StoredRecord> {
    const value = await client.jsonFrom(`${root}/releases/${String(id)}`, GitHubRelease, "GitHub release");
    const record = storedRecordFromResponse(value);
    await assertTagMatchesCommit(releaseTag(record.intent), record);
    await remember(record);
    return record;
  }

  /** Reserves the record for `intent`; an existing record must hold the same intent. */
  async function reserve(intent: ReleaseIntent): Promise<StoredRecord> {
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
    const created = storedRecordFromResponse(value);
    assertSameIntent(created.intent, intent);
    await remember(created);
    return created;
  }

  /** Attaches verified archive bytes, repairing the empty `starter` asset a failed upload leaves. */
  async function attach(record: StoredRecord, bytes: Uint8Array): Promise<AttachedRecord> {
    // Revalidate the intent and current asset before repairing an interrupted preparation.
    // `readRecord` has already re-checked that the record tag still points at the release commit.
    const current = await readRecord(record.id);
    assertSameIntent(current.intent, record.intent);
    if (current.asset.state === "uploaded") throw new Error("A recorded release archive cannot be replaced");
    if (current.asset.state === "starter") {
      await request(`${root}/releases/assets/${String(current.asset.id)}`, { method: "DELETE" });
    }
    const uploadedAsset = await client.json(
      await request(`${client.uploadRoot}/releases/${String(record.id)}/assets?name=${releaseArchiveName}`, {
        method: "POST",
        body: new Blob([new Uint8Array(bytes)]),
      }),
      GitHubReleaseAsset,
      "uploaded asset"
    );
    const attached: StoredRecord = {
      id: record.id,
      intent: current.intent,
      asset: classifyReleaseAsset(false, uploadedAsset),
    };
    await remember(attached);
    if (!isAttached(attached)) throw new Error("The uploaded release archive is not attached");
    return attached;
  }

  async function download(record: AttachedRecord): Promise<Uint8Array> {
    const response = await request(`${root}/releases/assets/${String(record.asset.id)}`, {
      accept: "application/octet-stream",
    });
    return new Uint8Array(await response.arrayBuffer());
  }

  async function reservedCanaryVersions(): Promise<readonly CanaryVersion[]> {
    const versions: CanaryVersion[] = [];
    for (const entry of (await releaseCatalog()).values()) {
      if (entry.kind === "record" && entry.record.intent.channel === "canary") {
        versions.push(entry.record.intent.version);
      }
    }
    return versions;
  }

  /** Downloads an attached record's archive and verifies those exact bytes against its intent. */
  function restoreAttached(record: AttachedRecord): Effect.Effect<PreparedRecord, ReleaseError, Scope.Scope> {
    return Effect.gen(function* () {
      const bytes = yield* liftPromise(() => download(record));
      const release = yield* verifyReleaseArchive(record.intent, bytes, packageName);
      return new PreparedRecord(record, release);
    });
  }

  return {
    recordedCanaryIntent: (commit) =>
      liftPromise(async () => {
        const record = await find(canaryRecordTag(commit));
        return record === undefined ? undefined : canaryIntentOf(record.intent);
      }),
    reservedCanaryVersions: () => liftPromise(() => reservedCanaryVersions()),
    prepare: (intent, adapter) =>
      Effect.gen(function* () {
        const record = yield* liftPromise(() => reserve(intent));
        if (isAttached(record)) return yield* restoreAttached(record);
        const bytes = yield* lift(() => adapter.pack(intent));
        const release = yield* verifyReleaseArchive(intent, bytes, packageName);
        const attached = yield* liftPromise(() => attach(record, bytes));
        return new PreparedRecord(attached, release);
      }),
    restore: (recordTag) =>
      Effect.gen(function* () {
        const tag = yield* lift(() => assertReleaseTag(recordTag));
        const record = yield* liftPromise(() => find(tag));
        if (record === undefined) {
          return yield* new ReleaseError({ message: `No prepared release exists for record tag ${tag}` });
        }
        if (!isAttached(record)) {
          return yield* new ReleaseError({
            message: incompletePreparation,
            cause: new Error(incompletePreparation),
          });
        }
        return yield* restoreAttached(record);
      }),
    complete: (record) =>
      liftPromise(async () => {
        await client.json(
          await request(`${root}/releases/${String(PreparedRecord.releaseIdOf(record))}`, {
            method: "PATCH",
            body: JSON.stringify({ draft: false, make_latest: "false" }),
          }),
          GitHubRelease,
          "GitHub release"
        );
      }),
  };
}
