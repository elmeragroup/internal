import { describe, expect, it } from "vitest";

import { asString, parseJsonArray } from "../scripts/lib/json-object.mjs";
import { createGitHubClient } from "../scripts/release-github-client.ts";
import { classifyReleaseAsset, createReleaseStore } from "../scripts/release-github.ts";
import type { ReleaseStore, SavedRelease } from "../scripts/release-github.ts";
import { verifiedBundleName } from "../scripts/release-record.ts";
import type { ReleaseIntent } from "../scripts/release-record.ts";

const commit = "a".repeat(40);
const intent: ReleaseIntent = { channel: "stable", version: "0.2.0", commit };
const saved: SavedRelease = { id: 1, intent, asset: { state: "uploaded", id: 2 } };
const uploadedAsset = { id: 2, name: verifiedBundleName, state: "uploaded", size: 12 };
const starterAsset = { id: 2, name: verifiedBundleName, state: "starter", size: 0 };

type ReleaseAssetPayload = { id: number; name: string; state: string; size: number };

type ReleasePayload = {
  tag_name: string;
  id: number;
  draft: boolean;
  body: string;
  assets: ReleaseAssetPayload[];
};

type StoreOptions = {
  created?: ReleasePayload;
  releaseId?: number;
  tagStatus?: number;
  tagSha?: string;
  status?: number;
};

function releaseRecord(overrides: Partial<ReleasePayload> = {}): ReleasePayload {
  return {
    tag_name: "v0.2.0",
    id: 1,
    draft: true,
    body: JSON.stringify({ schema: 1, ...intent }),
    assets: [starterAsset],
    ...overrides,
  };
}

async function savedRelease(store: ReleaseStore, tag: string): Promise<SavedRelease> {
  const found = await store.find(tag);
  if (found === undefined) throw new Error(`No saved release for ${tag}`);
  return found;
}

function githubStore(releases: readonly ReleasePayload[], options: StoreOptions = {}) {
  const state = { listed: 0, removed: false };
  const fetcher: typeof fetch = (url, init) => {
    const path = asString(url, "request URL");
    const method = init?.method ?? "GET";
    if (method === "DELETE") {
      state.removed = true;
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (method === "POST") {
      if (path.includes("/git/refs")) {
        return Promise.resolve(Response.json({ object: { type: "commit", sha: commit } }));
      }
      if (path.includes("/assets")) {
        return Promise.resolve(
          Response.json({ id: 3, state: "uploaded", size: 1, name: verifiedBundleName })
        );
      }
      return Promise.resolve(
        Response.json(options.created ?? releaseRecord({ id: options.releaseId ?? 1, assets: [] }))
      );
    }
    if (path.includes("/git/ref/")) {
      if (options.tagStatus === 404) return Promise.resolve(new Response("", { status: 404 }));
      return Promise.resolve(Response.json({ object: { type: "commit", sha: options.tagSha ?? commit } }));
    }
    const byId = /\/releases\/(\d+)$/.exec(path);
    if (byId !== null) {
      const found = releases.find((item) => item.id === Number(byId[1]));
      if (found === undefined) return Promise.resolve(new Response("", { status: 404 }));
      return Promise.resolve(Response.json(found));
    }
    if (path.includes("/releases?")) {
      if (options.status !== undefined) return Promise.resolve(new Response("", { status: options.status }));
      state.listed += 1;
      return Promise.resolve(Response.json(releases));
    }
    return Promise.resolve(new Response("", { status: options.status ?? 500 }));
  };
  const store = createReleaseStore(createGitHubClient("example/package", "test", fetcher));
  return { store, state };
}

describe("durable GitHub release records", () => {
  it("keeps starter lookup and publication retry read-only", async () => {
    const { store, state } = githubStore([releaseRecord()]);
    const found = await savedRelease(store, "v0.2.0");
    await expect(store.download(found)).rejects.toThrow("original Merge job");
    expect(state.removed).toBe(false);
    await expect(store.create({ ...intent, commit: "b".repeat(40) })).rejects.toThrow("intent differs");
    expect(state.removed).toBe(false);
    await store.upload(await store.create(intent), new Uint8Array());
    expect(state.removed).toBe(true);
  });
  it("rejects a moved tag before downloading an archive", async () => {
    const { store } = githubStore([releaseRecord({ assets: [uploadedAsset] })], { tagSha: "b".repeat(40) });
    await expect(store.find("v0.2.0")).rejects.toThrow("tag was moved");
  });
  it("recovers an uploaded asset from a still-draft release", async () => {
    const { store, state } = githubStore([releaseRecord({ assets: [uploadedAsset] })]);
    expect(await store.find("v0.2.0")).toEqual(saved);
    await expect(store.upload(saved, new Uint8Array())).rejects.toThrow("cannot be replaced");
    expect(state.listed).toBe(1);
  });
  it("revalidates upload against the known release id instead of listing again", async () => {
    const { store, state } = githubStore([releaseRecord()]);
    const created = await store.create(intent);
    expect(state.listed).toBe(1);
    const uploaded = await store.upload(created, new Uint8Array());
    expect(state.listed).toBe(1);
    expect(uploaded).toEqual({ id: 1, intent, asset: { state: "uploaded", id: 3 } });
  });
  it("fails closed when the archive was never uploaded", async () => {
    const store = createReleaseStore(
      createGitHubClient("example/package", "test", () => Promise.reject(new Error("must not request")))
    );
    await expect(store.download({ ...saved, asset: { state: "missing" } })).rejects.toThrow(
      "original Merge job"
    );
  });
  it("does not interpret authentication failures as missing releases", async () => {
    const { store } = githubStore([], { status: 403 });
    await expect(store.find("v0.2.0")).rejects.toThrow("403");
  });
  it("does not treat a missing listing page as an empty history", async () => {
    const { store } = githubStore([], { status: 404 });
    await expect(store.find("v0.2.0")).rejects.toThrow("404");
  });
  it("creates a tag when the ref lookup returns 404", async () => {
    const { store } = githubStore([], { tagStatus: 404, releaseId: 9 });
    await expect(store.create(intent)).resolves.toEqual({
      id: 9,
      intent,
      asset: { state: "missing" },
    });
  });
  it("includes unfinished canary reservations in version allocation", async () => {
    const canaryIntent = { channel: "canary", version: "0.2.0-canary.12", commit };
    const { store, state } = githubStore([
      {
        tag_name: `canary-${commit}`,
        id: 4,
        draft: true,
        body: JSON.stringify({ schema: 1, ...canaryIntent }),
        assets: [],
      },
    ]);
    expect(await store.find(`canary-${commit}`)).toEqual({
      id: 4,
      intent: canaryIntent,
      asset: { state: "missing" },
    });
    expect(await store.reservedCanaryVersions()).toEqual(["0.2.0-canary.12"]);
    expect(state.listed).toBe(1);
  });
  it("parses the created release rather than trusting the requested intent", async () => {
    const { store } = githubStore([], {
      created: releaseRecord({
        id: 9,
        assets: [],
        body: JSON.stringify({ schema: 1, ...intent, commit: "b".repeat(40) }),
      }),
    });
    await expect(store.create(intent)).rejects.toThrow("intent differs");
  });
  it("refuses to publish a record whose archive was never uploaded", async () => {
    const { store } = githubStore([releaseRecord({ assets: [uploadedAsset] })]);
    await expect(store.complete({ ...saved, asset: { state: "missing" } })).rejects.toThrow(
      "without its verified archive"
    );
    await expect(store.complete(saved)).resolves.toBeUndefined();
  });
  it("remembers a created draft without listing GitHub releases again", async () => {
    const { store, state } = githubStore([], { releaseId: 9 });
    await expect(store.create(intent)).resolves.toEqual({
      id: 9,
      intent,
      asset: { state: "missing" },
    });
    expect(state.listed).toBe(1);
    expect(await store.find("v0.2.0")).toEqual({
      id: 9,
      intent,
      asset: { state: "missing" },
    });
    expect(state.listed).toBe(1);
  });
});

describe("release asset classification", () => {
  it("classifies a draft starter and a non-zero uploaded asset", () => {
    expect(classifyReleaseAsset(true, { id: 2, state: "starter", size: 0 })).toEqual({
      state: "starter",
      id: 2,
    });
    expect(classifyReleaseAsset(true, { id: 2, state: "uploaded", size: 12 })).toEqual({
      state: "uploaded",
      id: 2,
    });
    expect(classifyReleaseAsset(true, undefined)).toEqual({ state: "missing" });
  });
  it("rejects a non-draft starter asset", async () => {
    expect(() => classifyReleaseAsset(false, { id: 2, state: "starter", size: 0 })).toThrow(
      "Unsupported starter release asset"
    );
    const { store } = githubStore([releaseRecord({ draft: false })]);
    await expect(store.find("v0.2.0")).rejects.toThrow("Unsupported starter release asset");
  });
  it("rejects an unknown asset state", async () => {
    const unknown = { id: 2, name: verifiedBundleName, state: "open", size: 0 };
    expect(() => classifyReleaseAsset(true, { id: 2, state: "open", size: 0 })).toThrow(
      "Unsupported release asset state open"
    );
    const { store } = githubStore([releaseRecord({ assets: [unknown] })]);
    await expect(store.find("v0.2.0")).rejects.toThrow("Unsupported release asset state open");
  });
  it("rejects a size-zero uploaded asset", async () => {
    const empty = { id: 2, name: verifiedBundleName, state: "uploaded", size: 0 };
    expect(() => classifyReleaseAsset(true, { id: 2, state: "uploaded", size: 0 })).toThrow(
      "Uploaded release asset has no bytes"
    );
    const { store } = githubStore([releaseRecord({ assets: [empty] })]);
    await expect(store.find("v0.2.0")).rejects.toThrow("Uploaded release asset has no bytes");
  });
});

describe("GitHub JSON arrays", () => {
  it("parses arrays directly and rejects a wrapped object", () => {
    expect(parseJsonArray('[{"id":1}]', "releases")).toEqual([{ id: 1 }]);
    expect(() => parseJsonArray('{"releases":[]}', "releases")).toThrow("not a JSON array");
  });
});
