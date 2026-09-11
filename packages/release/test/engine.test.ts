import { Effect } from "effect";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { EngineDeps, PackAndVerify } from "../src/engine.ts";
import { executeCheckedCommit, executeRetry, releaseCheckedCommit, retryRelease } from "../src/engine.ts";
import { ReleaseError } from "../src/errors.ts";
import type { ReleasePackage } from "../src/files.ts";
import type { ReleaseLine } from "../src/gate.ts";
import type { GitPort } from "../src/git.ts";
import type { ReleaseEnvironment } from "../src/github.ts";
import { canaryRecordTag, releaseTag } from "../src/intent.ts";
import type { ReleaseIntent, VerifiedRelease } from "../src/intent.ts";
import type { Registry } from "../src/npm.ts";
import type { CommitAncestry } from "../src/policy.ts";
import type { ReleaseStore, SavedRelease } from "../src/store.ts";

const commit = "a".repeat(40);
const newerCommit = "b".repeat(40);
const packedArchive = new Uint8Array([1, 2, 3]);
const storedArchive = new Uint8Array([7, 8, 9]);

const pkg: ReleasePackage = {
  checkoutRoot: "/checkout",
  packageDirectory: "/checkout/packages/app",
  packageName: "@acme/app",
};

function memoryStore(seed: readonly SavedRelease[] = []) {
  const byTag = new Map<string, SavedRelease>(seed.map((saved) => [releaseTag(saved.intent), saved]));
  const uploaded: Uint8Array[] = [];
  const store: ReleaseStore & { uploaded: Uint8Array[] } = {
    uploaded,
    find: vi.fn((tag: string) => Effect.succeed(byTag.get(tag))),
    create: vi.fn((intent: ReleaseIntent) =>
      Effect.sync(() => {
        const tag = releaseTag(intent);
        const existing = byTag.get(tag);
        if (existing !== undefined) return existing;
        const saved: SavedRelease = { id: byTag.size + 1, intent, asset: { state: "missing" } };
        byTag.set(tag, saved);
        return saved;
      })
    ),
    upload: vi.fn((release: SavedRelease, bytes: Uint8Array) =>
      Effect.sync(() => {
        uploaded.push(bytes);
        const saved: SavedRelease = {
          id: release.id,
          intent: release.intent,
          asset: { state: "uploaded", id: 9 },
        };
        byTag.set(releaseTag(release.intent), saved);
        return saved;
      })
    ),
    download: vi.fn((release: SavedRelease) =>
      release.asset.state === "uploaded"
        ? Effect.succeed(storedArchive)
        : Effect.fail(
            new ReleaseError({
              port: "store",
              message:
                "Release preparation is incomplete; rerun its original Merge job before retrying publication",
            })
          )
    ),
    complete: vi.fn(() => Effect.void),
    reservedCanaryVersions: vi.fn(() =>
      Effect.succeed(
        [...byTag.values()]
          .filter((saved) => saved.intent.channel === "canary")
          .map((saved) => saved.intent.version)
      )
    ),
  };
  return store;
}

type PipelineOptions = {
  current?: string;
  previous?: string;
  seed?: readonly SavedRelease[];
  registry?: Registry;
  isAncestor?: CommitAncestry;
  git?: Partial<GitPort>;
};

const emptyRegistry = (): Registry => ({ versions: new Map(), tags: new Map() });

const linearHistory: CommitAncestry = (ancestor, descendant) =>
  ancestor === descendant || (ancestor === commit && descendant === newerCommit);

function pipeline(options: PipelineOptions = {}) {
  const store = memoryStore(options.seed);
  const current = options.current ?? "0.1.9";
  const previous = options.previous ?? current;
  const registry = options.registry ?? emptyRegistry();
  let verified: VerifiedRelease | undefined;
  const stableVersionAt = vi.fn((revision: string) =>
    revision === `${commit}^1`
      ? Effect.succeed(previous)
      : Effect.fail(
          new ReleaseError({ port: "git", message: `No recorded manifest version for ${revision}` })
        )
  );
  const git: GitPort = {
    head: () => Effect.succeed(commit),
    originMain: () => Effect.succeed(commit),
    isClean: () => Effect.succeed(true),
    stableVersionAt,
    ...options.git,
  };
  const adapter: PackAndVerify = {
    pack: vi.fn(() => packedArchive),
  };
  const verifyArchive = vi.fn((intent: ReleaseIntent, _bytes: Uint8Array) => {
    verified = { ...intent, archive: "/verified/release.tgz", integrity: "sha512-test" };
    return Effect.succeed(verified);
  });
  const publish = vi.fn(
    (_archive: string): Effect.Effect<void, ReleaseError> =>
      Effect.sync(() => {
        if (verified !== undefined) {
          registry.versions.set(verified.version, { commit: verified.commit, integrity: verified.integrity });
        }
      })
  );
  const promote = vi.fn(
    (version: string, tag: string): Effect.Effect<void, ReleaseError> =>
      Effect.sync(() => {
        registry.tags.set(tag, version);
      })
  );
  const stableGate = vi.fn((_commit: string, seen: string) =>
    Effect.succeed<ReleaseLine>(
      current === seen ? { channel: "canary", current } : { channel: "stable", version: current }
    )
  );
  const plannedCanaryBase = vi.fn(() => Effect.succeed("0.2.0"));
  const readRegistry = vi.fn(() => Effect.succeed(registry));
  const bindings = {
    git,
    ancestry: options.isAncestor ?? linearHistory,
    store,
    readRegistry,
    npm: { publish, promote },
    confirmationInterval: 0,
    stableGate,
    plannedCanaryBase,
    verifyArchive,
    log: vi.fn(),
  } satisfies EngineDeps;
  return {
    bindings,
    store,
    adapter,
    verifyArchive,
    readRegistry,
    publish,
    promote,
    stableGate,
    plannedCanaryBase,
    stableVersionAt,
  };
}

function runMain(commitSha: string, bindings: EngineDeps, adapter: PackAndVerify): Promise<void> {
  return Effect.runPromise(executeCheckedCommit(pkg, adapter, commitSha, bindings).pipe(Effect.scoped));
}

function runRetry(tag: string, bindings: EngineDeps): Promise<void> {
  return Effect.runPromise(executeRetry(pkg, tag, bindings).pipe(Effect.scoped));
}

describe("main release preconditions", () => {
  it("refuses a checkout that is not the checked commit", async () => {
    const { bindings, store, adapter } = pipeline({ git: { head: () => Effect.succeed(newerCommit) } });
    await expect(runMain(commit, bindings, adapter)).rejects.toThrow(
      "Checkout differs from the checked commit"
    );
    expect(store.create).not.toHaveBeenCalled();
  });

  it("refuses a commit that is not on main", async () => {
    const { bindings, store, adapter } = pipeline({
      git: { originMain: () => Effect.succeed(newerCommit) },
      isAncestor: () => false,
    });
    await expect(runMain(commit, bindings, adapter)).rejects.toThrow("Release source is not on main");
    expect(store.create).not.toHaveBeenCalled();
  });

  it("refuses a dirty checkout", async () => {
    const { bindings, store, adapter } = pipeline({ git: { isClean: () => Effect.succeed(false) } });
    await expect(runMain(commit, bindings, adapter)).rejects.toThrow("Release requires a clean checkout");
    expect(store.create).not.toHaveBeenCalled();
  });

  it("compares the manifest against the parent of the released commit", async () => {
    const { bindings, adapter, stableVersionAt, stableGate } = pipeline({
      current: "0.2.0",
      previous: "0.1.9",
    });
    await runMain(commit, bindings, adapter);
    expect(stableVersionAt).toHaveBeenCalledWith(`${commit}^1`);
    expect(stableGate).toHaveBeenCalledWith(commit, "0.1.9");
  });
});

describe("main release plan execution", () => {
  it("records and finishes a stable version bump from the freshly packed bytes", async () => {
    const { bindings, store, adapter, verifyArchive, plannedCanaryBase, publish, promote } = pipeline({
      current: "0.2.0",
      previous: "0.1.9",
    });
    await runMain(commit, bindings, adapter);
    expect(store.create).toHaveBeenCalledWith({ channel: "stable", version: "0.2.0", commit });
    expect(adapter.pack).toHaveBeenCalled();
    expect(verifyArchive).toHaveBeenCalledWith(
      { channel: "stable", version: "0.2.0", commit },
      packedArchive
    );
    expect(store.uploaded).toEqual([packedArchive]);
    expect(store.download).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith("/verified/release.tgz");
    expect(promote).toHaveBeenCalledWith("0.2.0", "latest");
    expect(store.complete).toHaveBeenCalled();
    expect(plannedCanaryBase).not.toHaveBeenCalled();
  });

  it("prefers a stable version bump over a canary record for the same commit", async () => {
    const canary: ReleaseIntent = { channel: "canary", version: "0.2.0-canary.11", commit };
    const { bindings, store, adapter } = pipeline({
      current: "0.2.0",
      previous: "0.1.9",
      seed: [{ id: 4, intent: canary, asset: { state: "uploaded", id: 2 } }],
    });
    await runMain(commit, bindings, adapter);
    expect(store.create).toHaveBeenCalledWith({ channel: "stable", version: "0.2.0", commit });
    expect(store.find).not.toHaveBeenCalled();
  });

  it("resumes a saved canary record from its downloaded archive", async () => {
    const intent: ReleaseIntent = { channel: "canary", version: "0.2.0-canary.11", commit };
    const { bindings, store, adapter, verifyArchive, plannedCanaryBase, publish } = pipeline({
      seed: [{ id: 4, intent, asset: { state: "uploaded", id: 2 } }],
    });
    await runMain(commit, bindings, adapter);
    expect(store.create).toHaveBeenCalledWith(intent);
    expect(adapter.pack).not.toHaveBeenCalled();
    expect(store.upload).not.toHaveBeenCalled();
    expect(verifyArchive).toHaveBeenCalledWith(intent, storedArchive);
    expect(publish).toHaveBeenCalledWith("/verified/release.tgz");
    expect(store.complete).toHaveBeenCalled();
    expect(plannedCanaryBase).not.toHaveBeenCalled();
  });

  it("skips a commit superseded by a published canary", async () => {
    const { bindings, store, adapter } = pipeline({
      registry: {
        versions: new Map([["0.2.0-canary.12", { commit: newerCommit, integrity: "newer" }]]),
        tags: new Map(),
      },
    });
    await runMain(commit, bindings, adapter);
    expect(adapter.pack).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
    expect(bindings.log).toHaveBeenCalledWith("Skipping a commit superseded by a published canary");
  });

  it("skips a commit superseded by a stable release", async () => {
    const { bindings, store, adapter } = pipeline({
      registry: {
        versions: new Map([["0.2.0", { commit: newerCommit, integrity: "stable" }]]),
        tags: new Map(),
      },
    });
    await runMain(commit, bindings, adapter);
    expect(adapter.pack).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
    expect(bindings.log).toHaveBeenCalledWith("Skipping a commit superseded by a stable release");
  });

  it("allocates against the planned base after reserved canary versions", async () => {
    const reserved: SavedRelease = {
      id: 8,
      intent: { channel: "canary", version: "0.2.0-canary.13", commit: "d".repeat(40) },
      asset: { state: "missing" },
    };
    const { bindings, store, adapter, plannedCanaryBase } = pipeline({
      seed: [reserved],
      registry: {
        versions: new Map([["0.2.0-canary.12", { integrity: "legacy" }]]),
        tags: new Map(),
      },
    });
    await runMain(commit, bindings, adapter);
    expect(plannedCanaryBase).toHaveBeenCalledWith("0.1.9");
    expect(store.create).toHaveBeenCalledWith({ channel: "canary", version: "0.2.0-canary.14", commit });
    expect(adapter.pack).toHaveBeenCalled();
    expect(store.complete).toHaveBeenCalled();
  });

  it("blames the consumer pack adapter when packing fails", async () => {
    const { bindings, adapter } = pipeline({ current: "0.2.0", previous: "0.1.9" });
    adapter.pack = vi.fn(() => {
      throw new Error("build failed");
    });
    await expect(runMain(commit, bindings, adapter)).rejects.toMatchObject({
      _tag: "ReleaseError",
      port: "pack",
      message: "build failed",
    });
    expect(bindings.npm.publish).not.toHaveBeenCalled();
  });
});

describe("retry and finish", () => {
  it("refuses retry of an incomplete record", async () => {
    const intent: ReleaseIntent = { channel: "stable", version: "0.2.0", commit };
    const { bindings, store, verifyArchive } = pipeline({
      seed: [{ id: 1, intent, asset: { state: "missing" } }],
    });
    await expect(runRetry("v0.2.0", bindings)).rejects.toThrow("original Merge job");
    expect(verifyArchive).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
    expect(bindings.npm.publish).not.toHaveBeenCalled();
  });

  it("verifies the bytes it downloaded rather than the ones it packed", async () => {
    const intent: ReleaseIntent = { channel: "canary", version: "0.2.0-canary.11", commit };
    const { bindings, store, adapter, verifyArchive, publish } = pipeline({
      seed: [{ id: 4, intent, asset: { state: "uploaded", id: 2 } }],
    });
    await runRetry(canaryRecordTag(commit), bindings);
    expect(store.download).toHaveBeenCalled();
    expect(adapter.pack).not.toHaveBeenCalled();
    expect(verifyArchive).toHaveBeenCalledWith(intent, storedArchive);
    expect(publish).toHaveBeenCalled();
  });

  it("does not complete a superseded canary", async () => {
    const intent: ReleaseIntent = { channel: "canary", version: "0.2.0-canary.11", commit };
    const { bindings, store } = pipeline({
      seed: [{ id: 4, intent, asset: { state: "uploaded", id: 2 } }],
      registry: {
        versions: new Map([["0.2.0-canary.12", { commit: newerCommit, integrity: "newer" }]]),
        tags: new Map(),
      },
    });
    await runRetry(canaryRecordTag(commit), bindings);
    expect(bindings.npm.publish).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
    expect(bindings.log).toHaveBeenCalledWith(
      "Skipping superseded canary 0.2.0-canary.11; its draft record remains reserved"
    );
  });

  it("does not construct a pack adapter on retry", async () => {
    const intent: ReleaseIntent = { channel: "stable", version: "0.2.0", commit };
    const { bindings, adapter } = pipeline({
      seed: [{ id: 1, intent, asset: { state: "uploaded", id: 2 } }],
    });
    await runRetry("v0.2.0", bindings);
    expect(adapter.pack).not.toHaveBeenCalled();
  });
});

const missingCheckout: ReleasePackage = {
  checkoutRoot: "/missing-checkout",
  packageDirectory: "/missing-checkout/packages/app",
  packageName: "@acme/app",
};

async function withMissingGitHubCredentials(run: () => Promise<void>): Promise<void> {
  const previous = {
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
    GH_TOKEN: process.env.GH_TOKEN,
  };
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.GH_TOKEN;
  try {
    await run();
  } finally {
    if (previous.GITHUB_REPOSITORY === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = previous.GITHUB_REPOSITORY;
    if (previous.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous.GH_TOKEN;
  }
}

describe("shipped live operations", () => {
  it("constructs retryRelease without credentials and fails with ReleaseError when executed", async () => {
    await withMissingGitHubCredentials(async () => {
      const effect = retryRelease(missingCheckout, "v0.2.0");
      await expect(Effect.runPromise(effect)).rejects.toMatchObject({
        _tag: "ReleaseError",
        port: "engine",
        message: "GitHub repository and token are required",
      });
    });
  });

  it("constructs releaseCheckedCommit without credentials and fails with ReleaseError when executed", async () => {
    await withMissingGitHubCredentials(async () => {
      const effect = releaseCheckedCommit(missingCheckout, { pack: () => packedArchive }, commit);
      await expect(Effect.runPromise(effect)).rejects.toMatchObject({
        _tag: "ReleaseError",
        port: "engine",
        message: "GitHub repository and token are required",
      });
    });
  });

  it("threads an injected environment into the live transport", async () => {
    const root = mkdtempSync(join(tmpdir(), "elmera-release-environment-"));
    try {
      mkdirSync(join(root, ".changeset"), { recursive: true });
      writeFileSync(join(root, ".changeset/config.json"), JSON.stringify({ baseBranch: "origin/main" }));
      const requested: string[] = [];
      const environment: ReleaseEnvironment = {
        repository: "acme/app",
        token: "test-token",
        fetch: (input) => {
          requested.push(input instanceof URL ? input.href : input instanceof Request ? input.url : input);
          return Promise.resolve(new Response("", { status: 404 }));
        },
      };
      const pkg: ReleasePackage = {
        checkoutRoot: root,
        packageDirectory: root,
        packageName: "@acme/app",
      };
      await expect(Effect.runPromise(retryRelease(pkg, "v0.2.0", environment))).rejects.toThrow(
        "GitHub GET failed: 404"
      );
      expect(requested[0]).toContain("/releases?per_page=100");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
