import { describe, expect, it, vi } from "vitest";

import type { ReleaseLine } from "../scripts/release-gate.ts";
import type { GitPort } from "../scripts/release-git.ts";
import type { SavedRelease } from "../scripts/release-github.ts";
import { executeRelease, parseReleaseCommand } from "../scripts/release-pipeline.ts";
import type { ReleaseServices } from "../scripts/release-pipeline.ts";
import type { CommitAncestry } from "../scripts/release-policy.ts";
import { releaseTag } from "../scripts/release-record.ts";
import type { ReleaseIntent, VerifiedRelease } from "../scripts/release-record.ts";
import type { Registry } from "../scripts/release-registry.ts";

const commit = "a".repeat(40);
const newerCommit = "b".repeat(40);
const packedBundle = new Uint8Array([1, 2, 3]);
const storedBundle = new Uint8Array([7, 8, 9]);

function memoryStore(seed: readonly SavedRelease[] = []) {
  const byTag = new Map<string, SavedRelease>(seed.map((saved) => [releaseTag(saved.intent), saved]));
  const uploaded: Uint8Array[] = [];
  return {
    uploaded,
    find: vi.fn((tag: string) => Promise.resolve(byTag.get(tag))),
    create: vi.fn((intent: ReleaseIntent) => {
      const tag = releaseTag(intent);
      const existing = byTag.get(tag);
      if (existing !== undefined) return Promise.resolve(existing);
      const saved: SavedRelease = { id: byTag.size + 1, intent, asset: { state: "missing" } };
      byTag.set(tag, saved);
      return Promise.resolve(saved);
    }),
    upload: vi.fn((release: SavedRelease, bytes: Uint8Array) => {
      uploaded.push(bytes);
      const saved: SavedRelease = {
        id: release.id,
        intent: release.intent,
        asset: { state: "uploaded", id: 9 },
      };
      byTag.set(releaseTag(release.intent), saved);
      return Promise.resolve(saved);
    }),
    download: vi.fn((release: SavedRelease) =>
      release.asset.state === "uploaded"
        ? Promise.resolve(storedBundle)
        : Promise.reject(
            new Error(
              "Release preparation is incomplete; rerun its original Merge job before retrying publication"
            )
          )
    ),
    complete: vi.fn(() => Promise.resolve()),
    reservedCanaryVersions: vi.fn(() =>
      Promise.resolve(
        [...byTag.values()]
          .filter((saved) => saved.intent.channel === "canary")
          .map((saved) => saved.intent.version)
      )
    ),
  };
}

type PipelineOptions = {
  current?: string;
  previous?: string;
  seed?: readonly SavedRelease[];
  registry?: () => Promise<Registry>;
  publishVerified?: (release: VerifiedRelease) => Promise<"published" | "superseded">;
  isAncestor?: CommitAncestry;
  git?: Partial<GitPort>;
};

const linearHistory: CommitAncestry = (ancestor, descendant) =>
  ancestor === descendant || (ancestor === commit && descendant === newerCommit);

function pipeline(options: PipelineOptions = {}) {
  const store = memoryStore(options.seed);
  const current = options.current ?? "0.1.9";
  const previous = options.previous ?? current;
  // Keyed by revision, so a pipeline that stops reading the parent commit fails here.
  const stableVersionAt = vi.fn((revision: string) => {
    if (revision === `${commit}^1`) return previous;
    throw new Error(`No recorded manifest version for ${revision}`);
  });
  const git: GitPort = {
    head: () => commit,
    originMain: () => commit,
    isClean: () => true,
    stableVersionAt,
    isAncestor: options.isAncestor ?? linearHistory,
    ...options.git,
  };
  const archive = {
    pack: vi.fn(() => packedBundle),
    restore: vi.fn(
      (intent: ReleaseIntent): VerifiedRelease => ({
        ...intent,
        archive: "/verified/package.tgz",
        integrity: "sha512-test",
      })
    ),
  };
  const stableGate = vi.fn((_commit: string, seen: string) =>
    Promise.resolve<ReleaseLine>(
      current === seen ? { channel: "canary", current } : { channel: "stable", version: current }
    )
  );
  const plannedCanaryBase = vi.fn(() => "0.2.0");
  const services = {
    git,
    store,
    registry:
      options.registry ?? vi.fn(() => Promise.resolve<Registry>({ versions: new Map(), tags: new Map() })),
    archive,
    stableGate,
    plannedCanaryBase,
    publishVerified: options.publishVerified ?? vi.fn(() => Promise.resolve("published" as const)),
    log: vi.fn(),
  } satisfies ReleaseServices;
  return { services, store, archive, stableGate, plannedCanaryBase, stableVersionAt };
}

describe("release CLI command", () => {
  it("parses main versus retry at the boundary", () => {
    expect(parseReleaseCommand(["main", commit])).toEqual({ mode: "main", commit });
    expect(parseReleaseCommand(["retry", "v0.2.0"])).toEqual({ mode: "retry", tag: "v0.2.0" });
    expect(parseReleaseCommand(["retry", `canary-${commit}`])).toEqual({
      mode: "retry",
      tag: `canary-${commit}`,
    });
  });

  it.each<[readonly string[]]>([
    [[]],
    [["main"]],
    [["retry", "latest"]],
    [["publish", commit]],
    [["retry", "v01.0.0"]],
  ])("rejects %j", (argv) => {
    expect(() => parseReleaseCommand(argv)).toThrow();
  });
});

describe("main release preconditions", () => {
  it("refuses a checkout that is not the checked commit", async () => {
    const { services, store } = pipeline({ git: { head: () => newerCommit } });
    await expect(executeRelease({ mode: "main", commit }, services)).rejects.toThrow(
      "Checkout differs from the checked commit"
    );
    expect(store.create).not.toHaveBeenCalled();
  });

  it("refuses a commit that is not on main", async () => {
    const { services, store } = pipeline({
      git: { originMain: () => newerCommit },
      isAncestor: () => false,
    });
    await expect(executeRelease({ mode: "main", commit }, services)).rejects.toThrow(
      "Release source is not on main"
    );
    expect(store.create).not.toHaveBeenCalled();
  });

  it("refuses a dirty checkout", async () => {
    const { services, store } = pipeline({ git: { isClean: () => false } });
    await expect(executeRelease({ mode: "main", commit }, services)).rejects.toThrow(
      "Release requires a clean checkout"
    );
    expect(store.create).not.toHaveBeenCalled();
  });

  it("compares the manifest against the parent of the released commit", async () => {
    const { services, stableVersionAt, stableGate } = pipeline({ current: "0.2.0", previous: "0.1.9" });
    await executeRelease({ mode: "main", commit }, services);
    expect(stableVersionAt).toHaveBeenCalledWith(`${commit}^1`);
    expect(stableGate).toHaveBeenCalledWith(commit, "0.1.9");
  });
});

describe("main release plan execution", () => {
  it("records and finishes a stable version bump", async () => {
    const { services, store, archive, plannedCanaryBase } = pipeline({
      current: "0.2.0",
      previous: "0.1.9",
    });
    await executeRelease({ mode: "main", commit }, services);
    expect(store.create).toHaveBeenCalledWith({ channel: "stable", version: "0.2.0", commit });
    expect(archive.pack).toHaveBeenCalled();
    expect(store.uploaded).toEqual([packedBundle]);
    expect(archive.restore).toHaveBeenCalledWith(
      { channel: "stable", version: "0.2.0", commit },
      storedBundle
    );
    expect(services.publishVerified).toHaveBeenCalled();
    expect(store.complete).toHaveBeenCalled();
    expect(plannedCanaryBase).not.toHaveBeenCalled();
    expect(services.registry).not.toHaveBeenCalled();
  });

  it("prefers a stable version bump over a canary record for the same commit", async () => {
    const canary: ReleaseIntent = { channel: "canary", version: "0.2.0-canary.11", commit };
    const { services, store } = pipeline({
      current: "0.2.0",
      previous: "0.1.9",
      seed: [{ id: 4, intent: canary, asset: { state: "uploaded", id: 2 } }],
    });
    await executeRelease({ mode: "main", commit }, services);
    expect(store.create).toHaveBeenCalledWith({ channel: "stable", version: "0.2.0", commit });
    expect(store.find).not.toHaveBeenCalled();
  });

  it("resumes a saved canary record for the same commit", async () => {
    const intent: ReleaseIntent = { channel: "canary", version: "0.2.0-canary.11", commit };
    const { services, store, archive, plannedCanaryBase } = pipeline({
      seed: [{ id: 4, intent, asset: { state: "uploaded", id: 2 } }],
    });
    await executeRelease({ mode: "main", commit }, services);
    expect(store.create).toHaveBeenCalledWith(intent);
    expect(archive.pack).not.toHaveBeenCalled();
    expect(store.upload).not.toHaveBeenCalled();
    expect(services.publishVerified).toHaveBeenCalled();
    expect(store.complete).toHaveBeenCalled();
    expect(plannedCanaryBase).not.toHaveBeenCalled();
  });

  it("skips a commit superseded by a published canary", async () => {
    const { services, store, archive } = pipeline({
      registry: vi.fn(() =>
        Promise.resolve<Registry>({
          versions: new Map([["0.2.0-canary.12", { commit: newerCommit, integrity: "newer" }]]),
          tags: new Map(),
        })
      ),
    });
    await executeRelease({ mode: "main", commit }, services);
    expect(archive.pack).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
    expect(services.log).toHaveBeenCalledWith("Skipping a commit superseded by a published canary");
  });

  it("skips a commit superseded by a stable release", async () => {
    const { services, store, archive } = pipeline({
      registry: vi.fn(() =>
        Promise.resolve<Registry>({
          versions: new Map([["0.2.0", { commit: newerCommit, integrity: "stable" }]]),
          tags: new Map(),
        })
      ),
    });
    await executeRelease({ mode: "main", commit }, services);
    expect(archive.pack).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
    expect(services.log).toHaveBeenCalledWith("Skipping a commit superseded by a stable release");
  });

  it("allocates against the planned base after reserved canary versions", async () => {
    const reserved: SavedRelease = {
      id: 8,
      intent: { channel: "canary", version: "0.2.0-canary.13", commit: "d".repeat(40) },
      asset: { state: "missing" },
    };
    const { services, store, archive, plannedCanaryBase } = pipeline({
      seed: [reserved],
      registry: vi.fn(() =>
        Promise.resolve<Registry>({
          versions: new Map([["0.2.0-canary.12", { integrity: "legacy" }]]),
          tags: new Map(),
        })
      ),
    });
    await executeRelease({ mode: "main", commit }, services);
    expect(plannedCanaryBase).toHaveBeenCalledWith("0.1.9");
    expect(store.create).toHaveBeenCalledWith({ channel: "canary", version: "0.2.0-canary.14", commit });
    expect(archive.pack).toHaveBeenCalled();
    expect(store.complete).toHaveBeenCalled();
  });
});

describe("retry and finish", () => {
  it("refuses retry of an incomplete record", async () => {
    const intent: ReleaseIntent = { channel: "stable", version: "0.2.0", commit };
    const { services, store } = pipeline({
      seed: [{ id: 1, intent, asset: { state: "missing" } }],
    });
    await expect(executeRelease({ mode: "retry", tag: "v0.2.0" }, services)).rejects.toThrow(
      "original Merge job"
    );
    expect(store.complete).not.toHaveBeenCalled();
    expect(services.publishVerified).not.toHaveBeenCalled();
  });

  it("verifies the bytes it downloaded rather than the ones it packed", async () => {
    const intent: ReleaseIntent = { channel: "canary", version: "0.2.0-canary.11", commit };
    const { services, archive, store } = pipeline({
      seed: [{ id: 4, intent, asset: { state: "uploaded", id: 2 } }],
    });
    await executeRelease({ mode: "retry", tag: `canary-${commit}` }, services);
    expect(store.download).toHaveBeenCalled();
    expect(archive.restore).toHaveBeenCalledWith(intent, storedBundle);
  });

  it("does not complete a superseded canary", async () => {
    const intent: ReleaseIntent = { channel: "canary", version: "0.2.0-canary.11", commit };
    const { services, store } = pipeline({
      seed: [{ id: 4, intent, asset: { state: "uploaded", id: 2 } }],
      publishVerified: vi.fn(() => Promise.resolve("superseded" as const)),
    });
    await executeRelease({ mode: "retry", tag: `canary-${commit}` }, services);
    expect(services.publishVerified).toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
    expect(services.log).toHaveBeenCalledWith(
      "Skipping superseded canary 0.2.0-canary.11; its draft record remains reserved"
    );
  });
});
