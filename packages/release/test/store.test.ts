import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { createGitHubClient } from "../src/github.ts";
import { releaseRecordOwner, serializeIntent, verifiedBundleName } from "../src/intent.ts";
import type { ReleaseIntent } from "../src/intent.ts";
import { decodeJson, decodeJsonArray } from "../src/json.ts";
import { classifyReleaseAsset, createReleaseStore } from "../src/store.ts";
import type { ReleaseStore, SavedRelease } from "../src/store.ts";

const commit = "a".repeat(40);
const packageName = "@elmeragroup/internal";
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
  packageName?: string;
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

function isPostedJson(body: RequestInit["body"]): body is string {
  return Object.prototype.toString.call(body) === "[object String]";
}

function githubStore(releases: readonly ReleasePayload[], options: StoreOptions = {}) {
  const state = { listed: 0, removed: false };
  const mutations: string[] = [];
  const posted: { path: string; body: string }[] = [];
  const fetcher: typeof fetch = (url, init) => {
    const path = url instanceof URL ? url.href : url instanceof Request ? url.url : url;
    const method = init?.method ?? "GET";
    if (method !== "GET") mutations.push(`${method} ${path}`);
    if (method === "DELETE") {
      state.removed = true;
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (method === "POST") {
      if (isPostedJson(init?.body)) posted.push({ path, body: init.body });
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
  const store = createReleaseStore(
    createGitHubClient("example/package", "test", fetcher),
    options.packageName ?? packageName
  );
  return { store, state, mutations, posted };
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
      createGitHubClient("example/package", "test", () => Promise.reject(new Error("must not request"))),
      packageName
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

describe("release record ownership in the GitHub store", () => {
  it("ignores a foreign human release on a non-record tag during discovery", async () => {
    const canaryIntent = { channel: "canary" as const, version: "0.2.0-canary.12", commit };
    const { store, mutations } = githubStore([
      {
        tag_name: "weekly-notes",
        id: 3,
        draft: false,
        body: "Human release notes.",
        assets: [],
      },
      {
        tag_name: `canary-${commit}`,
        id: 4,
        draft: true,
        body: JSON.stringify({ schema: 1, ...canaryIntent }),
        assets: [],
      },
    ]);
    expect(await store.reservedCanaryVersions()).toEqual(["0.2.0-canary.12"]);
    expect(await store.find("weekly-notes")).toBeUndefined();
    expect(mutations.filter((entry) => !entry.startsWith("GET "))).toEqual([]);
  });

  it("fails a foreign occupant of the requested record tag without mutation", async () => {
    const { store, mutations } = githubStore([
      {
        tag_name: "v0.2.0",
        id: 8,
        draft: false,
        body: "Human release notes.",
        assets: [],
      },
    ]);
    await expect(store.find("v0.2.0")).rejects.toThrow("foreign GitHub release occupies the record tag");
    await expect(store.create(intent)).rejects.toThrow("foreign GitHub release occupies the record tag");
    expect(mutations.filter((entry) => /POST|PATCH|DELETE/.test(entry))).toEqual([]);
  });

  it("fails a malformed unmarked schema-1 candidate instead of treating it as foreign", async () => {
    const { store } = githubStore([
      {
        tag_name: "v0.2.0",
        id: 8,
        draft: true,
        body: JSON.stringify({ schema: 1, channel: "stable", version: "0.2.0" }),
        assets: [],
      },
    ]);
    await expect(store.find("v0.2.0")).rejects.toThrow("commit is not a string");
    await expect(store.create(intent)).rejects.toThrow("commit is not a string");
  });

  it("fails a marked owned record whose tag does not match its intent", async () => {
    const { store } = githubStore([
      {
        tag_name: "v0.2.0",
        id: 8,
        draft: true,
        body: serializeIntent({ channel: "canary", version: "0.2.0-canary.0", commit }),
        assets: [],
      },
    ]);
    await expect(store.find("v0.2.0")).rejects.toThrow("Release tag does not match its intent");
    await expect(store.reservedCanaryVersions()).rejects.toThrow("Release tag does not match its intent");
  });

  it("fails a marked owned record that cannot be decoded instead of dropping it", async () => {
    const { store } = githubStore([
      {
        tag_name: `canary-${commit}`,
        id: 4,
        draft: true,
        body: JSON.stringify({
          schema: 2,
          owner: releaseRecordOwner,
          channel: "canary",
          version: "0.2.0-canary.0",
          commit,
        }),
        assets: [],
      },
    ]);
    await expect(store.reservedCanaryVersions()).rejects.toThrow("Unsupported release intent");
    await expect(store.find(`canary-${commit}`)).rejects.toThrow("Unsupported release intent");
  });

  it("reads unmarked schema-1 records without rewriting them", async () => {
    const { store, mutations } = githubStore([releaseRecord({ assets: [] })]);
    expect(await store.find("v0.2.0")).toEqual({
      id: 1,
      intent,
      asset: { state: "missing" },
    });
    expect(mutations.filter((entry) => /POST|PATCH|DELETE/.test(entry))).toEqual([]);
  });

  it("writes the owner marker and package display name on create", async () => {
    const { store, posted } = githubStore([], {
      tagStatus: 404,
      releaseId: 9,
      packageName: "@acme/app",
      created: {
        tag_name: "v0.2.0",
        id: 9,
        draft: true,
        body: serializeIntent(intent),
        assets: [],
      },
    });
    await expect(store.create(intent)).resolves.toEqual({
      id: 9,
      intent,
      asset: { state: "missing" },
    });
    const created = posted.find((entry) => entry.path.endsWith("/releases"));
    expect(created).toBeDefined();
    const payload = decodeJson(
      created?.body ?? "{}",
      Schema.Struct({ name: Schema.String, body: Schema.String }),
      "created release"
    );
    expect(payload.name).toBe("@acme/app 0.2.0");
    expect(payload.body).toBe(serializeIntent(intent));
    expect(
      decodeJson(payload.body, Schema.Struct({ owner: Schema.optionalKey(Schema.String) }), "intent").owner
    ).toBe(releaseRecordOwner);
  });
});

describe("GitHub JSON arrays", () => {
  it("parses arrays directly and rejects a wrapped object", () => {
    expect(decodeJsonArray('[{"id":1}]', Schema.Struct({ id: Schema.Number }), "releases")).toEqual([
      { id: 1 },
    ]);
    expect(() =>
      decodeJsonArray('{"releases":[]}', Schema.Struct({ id: Schema.Number }), "releases")
    ).toThrow("not a JSON array");
  });
});
