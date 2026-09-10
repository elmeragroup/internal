import { Effect } from "effect";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type { PackAndVerify } from "../src/adapter.ts";
import { parseReleaseCommand } from "../src/command.ts";
import type { ReleasePackage } from "../src/config.ts";
import { executeCheckedCommit, executeRetry, releaseCheckedCommit, retryRelease } from "../src/engine.ts";
import type { EngineDeps } from "../src/engine.ts";
import { ReleaseError } from "../src/errors.ts";
import type { ReleaseLine } from "../src/gate.ts";
import type { GitPort } from "../src/git.ts";
import { releaseTag } from "../src/intent.ts";
import type { ReleaseIntent, VerifiedRelease } from "../src/intent.ts";
import type { CommitAncestry } from "../src/policy.ts";
import type { Registry } from "../src/registry.ts";
import { scratchDirectory } from "../src/scratch.ts";
import type { SavedRelease } from "../src/store.ts";

const commit = "a".repeat(40);
const newerCommit = "b".repeat(40);
const packedBundle = new Uint8Array([1, 2, 3]);
const storedBundle = new Uint8Array([7, 8, 9]);

const pkg: ReleasePackage = {
  checkoutRoot: "/checkout",
  packageDirectory: "/checkout/packages/app",
  packageName: "@acme/app",
};

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
  publishVerified?: (release: VerifiedRelease) => Effect.Effect<"published" | "superseded", ReleaseError>;
  isAncestor?: CommitAncestry;
  git?: Partial<GitPort>;
};

const linearHistory: CommitAncestry = (ancestor, descendant) =>
  ancestor === descendant || (ancestor === commit && descendant === newerCommit);

function pipeline(options: PipelineOptions = {}) {
  const store = memoryStore(options.seed);
  const current = options.current ?? "0.1.9";
  const previous = options.previous ?? current;
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
  const adapter: PackAndVerify = {
    pack: vi.fn(() => packedBundle),
  };
  const restore = vi.fn((intent: ReleaseIntent, _bundle: Uint8Array) =>
    Effect.succeed({
      ...intent,
      archive: "/verified/package.tgz",
      integrity: "sha512-test",
    })
  );
  const stableGate = vi.fn((_commit: string, seen: string) =>
    Promise.resolve<ReleaseLine>(
      current === seen ? { channel: "canary", current } : { channel: "stable", version: current }
    )
  );
  const plannedCanaryBase = vi.fn(() => "0.2.0");
  const bindings = {
    git,
    store,
    registry:
      options.registry ?? vi.fn(() => Promise.resolve<Registry>({ versions: new Map(), tags: new Map() })),
    stableGate,
    plannedCanaryBase,
    publishVerified: options.publishVerified ?? vi.fn(() => Effect.succeed("published" as const)),
    restore,
    log: vi.fn(),
  } satisfies EngineDeps;
  return { bindings, store, adapter, restore, stableGate, plannedCanaryBase, stableVersionAt };
}

function runMain(commitSha: string, bindings: EngineDeps, adapter: PackAndVerify): Promise<void> {
  return Effect.runPromise(executeCheckedCommit(pkg, adapter, commitSha, bindings).pipe(Effect.scoped));
}

function runRetry(tag: string, bindings: EngineDeps): Promise<void> {
  return Effect.runPromise(executeRetry(pkg, tag, bindings).pipe(Effect.scoped));
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
    const { bindings, store, adapter } = pipeline({ git: { head: () => newerCommit } });
    await expect(runMain(commit, bindings, adapter)).rejects.toThrow(
      "Checkout differs from the checked commit"
    );
    expect(store.create).not.toHaveBeenCalled();
  });

  it("refuses a commit that is not on main", async () => {
    const { bindings, store, adapter } = pipeline({
      git: { originMain: () => newerCommit },
      isAncestor: () => false,
    });
    await expect(runMain(commit, bindings, adapter)).rejects.toThrow("Release source is not on main");
    expect(store.create).not.toHaveBeenCalled();
  });

  it("refuses a dirty checkout", async () => {
    const { bindings, store, adapter } = pipeline({ git: { isClean: () => false } });
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
  it("records and finishes a stable version bump", async () => {
    const { bindings, store, adapter, restore, plannedCanaryBase } = pipeline({
      current: "0.2.0",
      previous: "0.1.9",
    });
    await runMain(commit, bindings, adapter);
    expect(store.create).toHaveBeenCalledWith({ channel: "stable", version: "0.2.0", commit });
    expect(adapter.pack).toHaveBeenCalled();
    expect(store.uploaded).toEqual([packedBundle]);
    expect(restore).toHaveBeenCalledWith({ channel: "stable", version: "0.2.0", commit }, storedBundle);
    expect(bindings.publishVerified).toHaveBeenCalled();
    expect(store.complete).toHaveBeenCalled();
    expect(plannedCanaryBase).not.toHaveBeenCalled();
    expect(bindings.registry).not.toHaveBeenCalled();
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

  it("resumes a saved canary record for the same commit", async () => {
    const intent: ReleaseIntent = { channel: "canary", version: "0.2.0-canary.11", commit };
    const { bindings, store, adapter, plannedCanaryBase } = pipeline({
      seed: [{ id: 4, intent, asset: { state: "uploaded", id: 2 } }],
    });
    await runMain(commit, bindings, adapter);
    expect(store.create).toHaveBeenCalledWith(intent);
    expect(adapter.pack).not.toHaveBeenCalled();
    expect(store.upload).not.toHaveBeenCalled();
    expect(bindings.publishVerified).toHaveBeenCalled();
    expect(store.complete).toHaveBeenCalled();
    expect(plannedCanaryBase).not.toHaveBeenCalled();
  });

  it("skips a commit superseded by a published canary", async () => {
    const { bindings, store, adapter } = pipeline({
      registry: vi.fn(() =>
        Promise.resolve<Registry>({
          versions: new Map([["0.2.0-canary.12", { commit: newerCommit, integrity: "newer" }]]),
          tags: new Map(),
        })
      ),
    });
    await runMain(commit, bindings, adapter);
    expect(adapter.pack).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
    expect(bindings.log).toHaveBeenCalledWith("Skipping a commit superseded by a published canary");
  });

  it("skips a commit superseded by a stable release", async () => {
    const { bindings, store, adapter } = pipeline({
      registry: vi.fn(() =>
        Promise.resolve<Registry>({
          versions: new Map([["0.2.0", { commit: newerCommit, integrity: "stable" }]]),
          tags: new Map(),
        })
      ),
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
      registry: vi.fn(() =>
        Promise.resolve<Registry>({
          versions: new Map([["0.2.0-canary.12", { integrity: "legacy" }]]),
          tags: new Map(),
        })
      ),
    });
    await runMain(commit, bindings, adapter);
    expect(plannedCanaryBase).toHaveBeenCalledWith("0.1.9");
    expect(store.create).toHaveBeenCalledWith({ channel: "canary", version: "0.2.0-canary.14", commit });
    expect(adapter.pack).toHaveBeenCalled();
    expect(store.complete).toHaveBeenCalled();
  });
});

describe("retry and finish", () => {
  it("refuses retry of an incomplete record", async () => {
    const intent: ReleaseIntent = { channel: "stable", version: "0.2.0", commit };
    const { bindings, store } = pipeline({
      seed: [{ id: 1, intent, asset: { state: "missing" } }],
    });
    await expect(runRetry("v0.2.0", bindings)).rejects.toThrow("original Merge job");
    expect(store.complete).not.toHaveBeenCalled();
    expect(bindings.publishVerified).not.toHaveBeenCalled();
  });

  it("verifies the bytes it downloaded rather than the ones it packed", async () => {
    const intent: ReleaseIntent = { channel: "canary", version: "0.2.0-canary.11", commit };
    const { bindings, store, adapter, restore } = pipeline({
      seed: [{ id: 4, intent, asset: { state: "uploaded", id: 2 } }],
    });
    await runRetry(`canary-${commit}`, bindings);
    expect(store.download).toHaveBeenCalled();
    expect(adapter.pack).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledWith(intent, storedBundle);
    expect(bindings.publishVerified).toHaveBeenCalled();
  });

  it("does not complete a superseded canary", async () => {
    const intent: ReleaseIntent = { channel: "canary", version: "0.2.0-canary.11", commit };
    const { bindings, store } = pipeline({
      seed: [{ id: 4, intent, asset: { state: "uploaded", id: 2 } }],
      publishVerified: vi.fn(() => Effect.succeed("superseded" as const)),
    });
    await runRetry(`canary-${commit}`, bindings);
    expect(bindings.publishVerified).toHaveBeenCalled();
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

describe("scoped scratch cleanup", () => {
  it("removes scratch directories when the scoped effect fails", async () => {
    const prefix = `elmera-release-scope-${String(process.pid)}-`;
    const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)));
    await expect(
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const directory = yield* scratchDirectory(prefix);
            expect(existsSync(directory)).toBe(true);
            return yield* new ReleaseError({ message: "restore failed" });
          })
        )
      )
    ).rejects.toThrow("restore failed");
    const leftover = readdirSync(tmpdir()).filter((name) => name.startsWith(prefix) && !before.has(name));
    expect(leftover).toEqual([]);
  });
});

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const missingCheckout: ReleasePackage = {
  checkoutRoot: "/missing-checkout",
  packageDirectory: "/missing-checkout/packages/app",
  packageName: "@acme/app",
};
const internalPackage: ReleasePackage = {
  checkoutRoot: repoRoot,
  packageDirectory: join(repoRoot, "packages/internal"),
  packageName: "@elmeragroup/internal",
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
        message: "GitHub repository and token are required",
      });
    });
  });

  it("constructs releaseCheckedCommit without credentials and fails with ReleaseError when executed", async () => {
    await withMissingGitHubCredentials(async () => {
      const effect = releaseCheckedCommit(internalPackage, { pack: () => packedBundle }, commit);
      await expect(Effect.runPromise(effect)).rejects.toMatchObject({
        _tag: "ReleaseError",
        message: "GitHub repository and token are required",
      });
    });
  });

  it("constructs createInternalPackAndVerify only on the main publish command", () => {
    const source = readFileSync(join(repoRoot, "scripts/publish-release.ts"), "utf8");
    const main = source.indexOf('command.mode === "main"');
    const pack = source.indexOf("createInternalPackAndVerify()");
    const retry = source.indexOf("retryRelease(");
    expect(main).toBeGreaterThan(-1);
    expect(pack).toBeGreaterThan(main);
    expect(retry).toBeGreaterThan(pack);
    expect(source.indexOf("createInternalPackAndVerify()", pack + 1)).toBe(-1);
  });
});
