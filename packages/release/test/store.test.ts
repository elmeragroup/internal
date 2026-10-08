import { Effect, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import type { ReleaseError } from "../src/errors.ts";
import { createGitHubClient } from "../src/github.ts";
import type { ReleaseIntent } from "../src/intent.ts";
import { decodeJson } from "../src/json.ts";
import { releaseRecordOwner, serializeIntent } from "../src/record.ts";
import { createRecordStore } from "../src/store.ts";
import type { PreparedRecord, RecordStore } from "../src/store.ts";
import { archiveIntegrity, createFakeRemote } from "./lib/fake-remote.ts";
import type { FakeRemote, SeededAsset } from "./lib/fake-remote.ts";
import { packArchive, recordingPacker } from "./lib/packed-archive.ts";
import { commit, commitSha, releaseIntent } from "./lib/release-fixtures.ts";

const repository = "example/package";
const packageName = "@elmeragroup/internal";
const githubApi = `https://api.github.com/repos/${repository}`;
const releaseListing = /\/releases\?per_page=100&page=\d+$/u;
const intent: ReleaseIntent = releaseIntent("0.2.0");
const legacyBody = JSON.stringify({ schema: 1, ...intent });
const archive = packArchive(packageName, intent);
const starterAsset: SeededAsset = { state: "starter", size: 0 };

function fakeRemote(): FakeRemote {
  return createFakeRemote(repository, packageName);
}

function storeOver(remote: FakeRemote, name = packageName): RecordStore {
  return createRecordStore(createGitHubClient(remote.environment), name);
}

function run<A>(effect: Effect.Effect<A, ReleaseError, Scope.Scope>): Promise<A> {
  return Effect.runPromise(Effect.scoped(effect));
}

/** Seeds an unmarked schema-1 `v0.2.0` record pinned to `commit`; returns its release id. */
function seedStableRecord(remote: FakeRemote, assets: readonly SeededAsset[], draft = true): number {
  remote.seedTag("v0.2.0", commit);
  return remote.seedRelease({ tag: "v0.2.0", body: legacyBody, draft, assets });
}

function assetId(remote: FakeRemote, tag: string): number {
  const [asset] = remote.release(tag).assets;
  if (asset === undefined) throw new Error(`No asset on ${tag}`);
  return asset.id;
}

function listings(remote: FakeRemote): number {
  return remote.requests.filter((request) => request.method === "GET" && releaseListing.test(request.url))
    .length;
}

function attachedArchives(remote: FakeRemote, tag: string) {
  return remote.release(tag).assets.map(({ state, bytes }) => ({ state, bytes }));
}

describe("preparing a record", () => {
  it("keeps starter lookup and publication retry read-only, then repairs the starter on preparation", async () => {
    const remote = fakeRemote();
    seedStableRecord(remote, [starterAsset]);
    const starter = assetId(remote, "v0.2.0");
    const store = storeOver(remote);
    const packer = recordingPacker(packageName);
    await expect(run(store.restore("v0.2.0"))).rejects.toThrow("original Merge job");
    expect(remote.mutations()).toEqual([]);
    await expect(run(store.prepare({ ...intent, commit: commitSha("b") }, packer.adapter))).rejects.toThrow(
      "intent differs"
    );
    expect(remote.mutations()).toEqual([]);
    expect(packer.packed).toEqual([]);
    await run(store.prepare(intent, packer.adapter));
    expect(packer.packed).toHaveLength(1);
    expect(remote.mutations()[0]).toBe(`DELETE ${githubApi}/releases/assets/${String(starter)}`);
    expect(attachedArchives(remote, "v0.2.0")).toEqual([{ state: "uploaded", bytes: packer.packed[0] }]);
  });

  it("repairs the empty starter asset a failed upload leaves", async () => {
    const remote = fakeRemote();
    const packer = recordingPacker(packageName);
    remote.failNextUpload();
    await expect(run(storeOver(remote).prepare(intent, packer.adapter))).rejects.toThrow(
      "GitHub POST failed: 502"
    );
    expect(remote.release("v0.2.0").assets.map(({ state, size }) => ({ state, size }))).toEqual([
      { state: "starter", size: 0 },
    ]);
    const prepared = await run(storeOver(remote).prepare(intent, packer.adapter));
    expect(packer.packed).toHaveLength(2);
    expect(attachedArchives(remote, "v0.2.0")).toEqual([{ state: "uploaded", bytes: packer.packed[1] }]);
    expect(prepared.release.integrity).toBe(archiveIntegrity(packer.packed[1] ?? new Uint8Array()));
  });

  it("restores an attached archive from a still-draft release instead of packing", async () => {
    const remote = fakeRemote();
    seedStableRecord(remote, [{ bytes: archive }]);
    const packer = recordingPacker(packageName);
    const prepared = await run(storeOver(remote).prepare(intent, packer.adapter));
    expect(packer.packed).toEqual([]);
    expect(prepared.intent).toEqual(intent);
    expect(prepared.tag).toBe("v0.2.0");
    expect(prepared.release).toMatchObject({ ...intent, integrity: archiveIntegrity(archive) });
    expect(remote.mutations()).toEqual([]);
    expect(listings(remote)).toBe(1);
  });

  it("never replaces an archive attached since the listing", async () => {
    const remote = fakeRemote();
    const id = seedStableRecord(remote, [starterAsset]);
    // A concurrent preparation attached the archive after this store listed the starter.
    remote.override("GET", `${githubApi}/releases/${String(id)}`, () =>
      Response.json({
        id,
        tag_name: "v0.2.0",
        draft: true,
        body: legacyBody,
        assets: [{ id: 99, name: "release.tgz", state: "uploaded", size: archive.length }],
      })
    );
    await expect(
      run(storeOver(remote).prepare(intent, recordingPacker(packageName).adapter))
    ).rejects.toThrow("A recorded release archive cannot be replaced");
    expect(remote.count("POST", "/assets")).toBe(0);
    expect(remote.count("DELETE", "/assets")).toBe(0);
  });

  it("revalidates the upload against the known release id instead of listing again", async () => {
    const remote = fakeRemote();
    const id = seedStableRecord(remote, [starterAsset]);
    await run(storeOver(remote).prepare(intent, recordingPacker(packageName).adapter));
    expect(listings(remote)).toBe(1);
    expect(remote.count("GET", `/releases/${String(id)}`)).toBe(1);
    expect(attachedArchives(remote, "v0.2.0")).toHaveLength(1);
  });

  it("verifies packed bytes before attaching them", async () => {
    const remote = fakeRemote();
    const wrong = packArchive(packageName, releaseIntent("0.2.1"));
    await expect(run(storeOver(remote).prepare(intent, { pack: () => wrong }))).rejects.toThrow(
      "Archive does not match the recorded release source"
    );
    expect(remote.count("POST", "/assets")).toBe(0);
    expect(remote.release("v0.2.0").assets).toEqual([]);
  });

  it("creates a tag when the ref lookup returns 404", async () => {
    const remote = fakeRemote();
    await run(storeOver(remote).prepare(intent, recordingPacker(packageName).adapter));
    expect(remote.tag("v0.2.0")).toBe(commit);
    expect(remote.mutations()).toEqual([
      `POST ${githubApi}/git/refs`,
      `POST ${githubApi}/releases`,
      `POST https://uploads.github.com/repos/${repository}/releases/${String(remote.release("v0.2.0").id)}/assets?name=release.tgz`,
    ]);
  });

  it("parses the created release rather than trusting the requested intent", async () => {
    const remote = fakeRemote();
    const packer = recordingPacker(packageName);
    remote.override("POST", `${githubApi}/releases`, () =>
      Response.json(
        {
          id: 9,
          tag_name: "v0.2.0",
          draft: true,
          body: JSON.stringify({ schema: 1, ...intent, commit: commitSha("b") }),
          assets: [],
        },
        { status: 201 }
      )
    );
    await expect(run(storeOver(remote).prepare(intent, packer.adapter))).rejects.toThrow("intent differs");
    expect(packer.packed).toEqual([]);
  });

  it("remembers a created draft without listing GitHub releases again", async () => {
    const remote = fakeRemote();
    const store = storeOver(remote);
    await run(store.prepare(intent, recordingPacker(packageName).adapter));
    expect(listings(remote)).toBe(1);
    const restored = await run(store.restore("v0.2.0"));
    expect(restored.intent).toEqual(intent);
    expect(listings(remote)).toBe(1);
  });

  it("writes the owner marker and package display name on create", async () => {
    const remote = fakeRemote();
    await run(storeOver(remote, "@acme/app").prepare(intent, recordingPacker("@acme/app").adapter));
    const created = remote.release("v0.2.0");
    expect(created.name).toBe("@acme/app 0.2.0");
    expect(created.body).toBe(serializeIntent(intent));
    expect(
      decodeJson(created.body ?? "", Schema.Struct({ owner: Schema.optionalKey(Schema.String) }), "intent")
        .owner
    ).toBe(releaseRecordOwner);
  });
});

describe("restoring and completing a record", () => {
  it("restores the recorded archive and verifies those exact bytes", async () => {
    const remote = fakeRemote();
    seedStableRecord(remote, [{ bytes: archive }]);
    const prepared = await run(storeOver(remote).restore("v0.2.0"));
    expect(prepared.intent).toEqual(intent);
    expect(prepared.release.integrity).toBe(archiveIntegrity(archive));
    expect(remote.mutations()).toEqual([]);
  });

  it("refuses a recorded archive that does not match its intent", async () => {
    const remote = fakeRemote();
    seedStableRecord(remote, [{ bytes: packArchive(packageName, releaseIntent("0.2.1")) }]);
    await expect(run(storeOver(remote).restore("v0.2.0"))).rejects.toThrow(
      "Archive does not match the recorded release source"
    );
  });

  it("rejects a moved tag before downloading an archive", async () => {
    const remote = fakeRemote();
    seedStableRecord(remote, [{ bytes: archive }]);
    remote.seedTag("v0.2.0", commitSha("b"));
    await expect(run(storeOver(remote).restore("v0.2.0"))).rejects.toThrow("v0.2.0 was moved");
    expect(remote.count("GET", "/releases/assets/")).toBe(0);
  });

  it("fails closed when the archive was never uploaded", async () => {
    const remote = fakeRemote();
    seedStableRecord(remote, []);
    await expect(run(storeOver(remote).restore("v0.2.0"))).rejects.toThrow(
      "Release preparation is incomplete; rerun its original Merge job before retrying publication"
    );
    expect(remote.count("GET", "/releases/assets/")).toBe(0);
    expect(remote.mutations()).toEqual([]);
  });

  it("names the requested tag when no record exists", async () => {
    const remote = fakeRemote();
    await expect(run(storeOver(remote).restore("v9.9.9"))).rejects.toThrow(
      "No prepared release exists for record tag v9.9.9"
    );
  });

  it("refuses a tag that is not a record tag", async () => {
    const remote = fakeRemote();
    await expect(run(storeOver(remote).restore("weekly-notes"))).rejects.toThrow(
      "Expected a stable or canary release record tag; received weekly-notes"
    );
    expect(remote.requests).toEqual([]);
  });

  it("completes a prepared record by publishing its draft release", async () => {
    const remote = fakeRemote();
    const id = seedStableRecord(remote, [{ bytes: archive }]);
    const store = storeOver(remote);
    const prepared = await run(store.restore("v0.2.0"));
    expect(remote.release("v0.2.0").draft).toBe(true);
    await Effect.runPromise(store.complete(prepared));
    expect(remote.mutations()).toEqual([`PATCH ${githubApi}/releases/${String(id)}`]);
    expect(remote.release("v0.2.0").draft).toBe(false);
  });

  it("accepts only a record the store prepared", () => {
    // Never called: these bodies exist so the type checker proves neither forgery compiles.
    const completeLiteral = (store: RecordStore, prepared: PreparedRecord) =>
      // @ts-expect-error -- an object literal lacks the store's private release id.
      store.complete({ intent: prepared.intent, release: prepared.release, tag: prepared.tag });
    const completeSpread = (store: RecordStore, prepared: PreparedRecord) =>
      store.complete(
        // @ts-expect-error -- a spread copy drops the private release id, so an unverified archive cannot ride along.
        {
          // oxlint-disable-next-line typescript/no-misused-spread -- the spread is the forgery this case proves impossible.
          ...prepared,
          release: { ...prepared.release, archive: "/unverified/archive.tgz" },
        }
      );
    expect(completeLiteral).toBeTypeOf("function");
    expect(completeSpread).toBeTypeOf("function");
  });

  it("does not interpret authentication failures as missing releases", async () => {
    const remote = fakeRemote();
    remote.override("GET", releaseListing, () => new Response("", { status: 403 }));
    await expect(run(storeOver(remote).restore("v0.2.0"))).rejects.toThrow("403");
  });

  it("does not treat a missing listing page as an empty history", async () => {
    const remote = fakeRemote();
    remote.override("GET", releaseListing, () => new Response("", { status: 404 }));
    await expect(run(storeOver(remote).restore("v0.2.0"))).rejects.toThrow("404");
  });
});

describe("canary reservations", () => {
  it("includes unfinished canary reservations in canary numbering", async () => {
    const remote = fakeRemote();
    const canaryIntent = releaseIntent("0.2.0-canary.12");
    remote.seedTag(`canary-${commit}`, commit);
    remote.seedRelease({ tag: `canary-${commit}`, body: JSON.stringify({ schema: 1, ...canaryIntent }) });
    const store = storeOver(remote);
    expect(await Effect.runPromise(store.recordedCanaryIntent(commit))).toEqual(canaryIntent);
    expect(await Effect.runPromise(store.reservedCanaryVersions())).toEqual(["0.2.0-canary.12"]);
    expect(listings(remote)).toBe(1);
  });

  it("has no recorded canary intent for a commit without a record", async () => {
    const remote = fakeRemote();
    expect(await Effect.runPromise(storeOver(remote).recordedCanaryIntent(commit))).toBeUndefined();
  });

  it("reads every listing page, drafts included", async () => {
    const remote = fakeRemote();
    remote.seedRelease({ tag: `canary-${commit}`, body: serializeIntent(releaseIntent("0.2.0-canary.12")) });
    for (let index = 0; index < 100; index += 1) {
      remote.seedRelease({ tag: `notes-${String(index)}`, body: "Human release notes.", draft: false });
    }
    expect(await Effect.runPromise(storeOver(remote).reservedCanaryVersions())).toEqual(["0.2.0-canary.12"]);
    expect(listings(remote)).toBe(2);
  });
});

describe("release asset classification", () => {
  it("rejects a non-draft starter asset", async () => {
    const remote = fakeRemote();
    seedStableRecord(remote, [starterAsset], false);
    await expect(run(storeOver(remote).restore("v0.2.0"))).rejects.toThrow(
      "Unsupported starter release asset"
    );
  });

  it("rejects an unknown asset state", async () => {
    const remote = fakeRemote();
    seedStableRecord(remote, [{ state: "open", size: 0 }]);
    await expect(run(storeOver(remote).restore("v0.2.0"))).rejects.toThrow(
      "Unsupported release asset state open"
    );
  });

  it("rejects a size-zero uploaded asset", async () => {
    const remote = fakeRemote();
    seedStableRecord(remote, [{ state: "uploaded", size: 0 }]);
    await expect(run(storeOver(remote).restore("v0.2.0"))).rejects.toThrow(
      "Uploaded release asset has no bytes"
    );
  });

  it("rejects a record carrying two recorded archives", async () => {
    const remote = fakeRemote();
    seedStableRecord(remote, [{ bytes: archive }, { bytes: archive }]);
    await expect(run(storeOver(remote).restore("v0.2.0"))).rejects.toThrow("Duplicate release archives");
  });
});

describe("release record ownership in the Record store", () => {
  it("ignores a foreign human release on a non-record tag during discovery", async () => {
    const remote = fakeRemote();
    remote.seedRelease({ tag: "weekly-notes", body: "Human release notes.", draft: false });
    remote.seedRelease({
      tag: `canary-${commit}`,
      body: JSON.stringify({ schema: 1, channel: "canary", version: "0.2.0-canary.12", commit }),
    });
    expect(await Effect.runPromise(storeOver(remote).reservedCanaryVersions())).toEqual(["0.2.0-canary.12"]);
    expect(remote.mutations()).toEqual([]);
  });

  it("fails a foreign occupant of the requested record tag without mutation", async () => {
    const remote = fakeRemote();
    remote.seedRelease({ tag: "v0.2.0", body: "Human release notes.", draft: false });
    const store = storeOver(remote);
    const packer = recordingPacker(packageName);
    await expect(run(store.restore("v0.2.0"))).rejects.toThrow("foreign GitHub release occupies");
    await expect(run(store.prepare(intent, packer.adapter))).rejects.toThrow(
      "foreign GitHub release occupies"
    );
    expect(remote.mutations()).toEqual([]);
    expect(packer.packed).toEqual([]);
  });

  it("fails a malformed unmarked schema-1 candidate instead of treating it as foreign", async () => {
    const remote = fakeRemote();
    remote.seedRelease({
      tag: "v0.2.0",
      body: JSON.stringify({ schema: 1, channel: "stable", version: "0.2.0" }),
    });
    const store = storeOver(remote);
    await expect(run(store.restore("v0.2.0"))).rejects.toThrow("release intent is invalid");
    await expect(run(store.prepare(intent, recordingPacker(packageName).adapter))).rejects.toThrow(
      "release intent is invalid"
    );
    expect(remote.mutations()).toEqual([]);
  });

  it("fails a marked owned record whose tag does not match its intent, naming the tag", async () => {
    const remote = fakeRemote();
    remote.seedRelease({ tag: "v0.2.0", body: serializeIntent(releaseIntent("0.2.0-canary.0")) });
    const store = storeOver(remote);
    await expect(run(store.restore("v0.2.0"))).rejects.toThrow(
      "Release record v0.2.0 is damaged: Release tag does not match its intent"
    );
    await expect(Effect.runPromise(store.reservedCanaryVersions())).resolves.toEqual([]);
  });

  it("names a marked owned record that cannot be decoded without blocking the catalog", async () => {
    const remote = fakeRemote();
    const otherCommit = commitSha("b");
    remote.seedRelease({
      tag: `canary-${commit}`,
      body: JSON.stringify({
        schema: 2,
        owner: releaseRecordOwner,
        channel: "canary",
        version: "0.2.0-canary.0",
        commit,
      }),
    });
    remote.seedRelease({
      tag: `canary-${otherCommit}`,
      body: serializeIntent(releaseIntent("0.2.0-canary.12", otherCommit)),
    });
    const stable = releaseIntent("0.1.9");
    remote.seedTag("v0.1.9", commit);
    remote.seedRelease({
      tag: "v0.1.9",
      body: JSON.stringify({ schema: 1, ...stable }),
      assets: [{ bytes: packArchive(packageName, stable) }],
    });
    const store = storeOver(remote);
    expect(await Effect.runPromise(store.reservedCanaryVersions())).toEqual(["0.2.0-canary.12"]);
    expect((await run(store.restore("v0.1.9"))).intent).toEqual(stable);
    await expect(Effect.runPromise(store.recordedCanaryIntent(commit))).rejects.toThrow(
      `Release record canary-${commit} is damaged: release intent is invalid`
    );
  });

  it("reads unmarked schema-1 records without rewriting them", async () => {
    const remote = fakeRemote();
    seedStableRecord(remote, [{ bytes: archive }]);
    expect((await run(storeOver(remote).restore("v0.2.0"))).intent).toEqual(intent);
    expect(remote.mutations()).toEqual([]);
    expect(remote.release("v0.2.0").body).toBe(legacyBody);
  });
});

describe("GitHub JSON arrays", () => {
  it("rejects a wrapped object where a release array is required", async () => {
    const remote = fakeRemote();
    remote.override("GET", releaseListing, () => Response.json({ releases: [] }));
    await expect(Effect.runPromise(storeOver(remote).reservedCanaryVersions())).rejects.toThrow(
      "GitHub releases is invalid"
    );
  });
});
