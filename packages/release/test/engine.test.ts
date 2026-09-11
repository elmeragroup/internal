import { Effect } from "effect";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { EngineDeps, PackAndVerify } from "../src/engine.ts";
import {
  createReleaseOperations,
  executeCheckedCommit,
  executeRetry,
  releaseCheckedCommit,
  retryRelease,
} from "../src/engine.ts";
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

const stableLine: ReleaseLine = { channel: "stable", version: "0.2.0" };
const canaryLine: ReleaseLine = { channel: "canary", current: "0.1.9" };

const linearHistory: CommitAncestry = (ancestor, descendant) =>
  ancestor === descendant || (ancestor === commit && descendant === newerCommit);

const emptyRegistry = (): Registry => ({ versions: new Map(), tags: new Map() });

type Outcome = {
  created: ReleaseIntent[];
  verified: { intent: ReleaseIntent; bytes: Uint8Array }[];
  uploaded: Uint8Array[];
  completed: number[];
  published: string[];
  promoted: { version: string; tag: string }[];
  logs: string[];
};

type HarnessOptions = {
  line?: ReleaseLine;
  base?: string;
  registry?: Registry;
  seed?: readonly SavedRelease[];
  isAncestor?: CommitAncestry;
  git?: Partial<GitPort>;
};

function harness(options: HarnessOptions = {}) {
  const registry = options.registry ?? emptyRegistry();
  const byTag = new Map<string, SavedRelease>(
    (options.seed ?? []).map((saved) => [releaseTag(saved.intent), saved])
  );
  const outcome: Outcome = {
    created: [],
    verified: [],
    uploaded: [],
    completed: [],
    published: [],
    promoted: [],
    logs: [],
  };
  let verified: VerifiedRelease | undefined;

  const store: ReleaseStore = {
    find: (tag) => Effect.succeed(byTag.get(tag)),
    create: (intent) =>
      Effect.sync(() => {
        const existing = byTag.get(releaseTag(intent));
        if (existing !== undefined) return existing;
        outcome.created.push(intent);
        const saved: SavedRelease = { id: byTag.size + 1, intent, asset: { state: "missing" } };
        byTag.set(releaseTag(intent), saved);
        return saved;
      }),
    upload: (release, bytes) =>
      Effect.sync(() => {
        outcome.uploaded.push(bytes);
        const saved: SavedRelease = {
          id: release.id,
          intent: release.intent,
          asset: { state: "uploaded", id: 9 },
        };
        byTag.set(releaseTag(saved.intent), saved);
        return saved;
      }),
    download: (release) =>
      release.asset.state === "uploaded"
        ? Effect.succeed(storedArchive)
        : Effect.fail(
            new ReleaseError({
              message:
                "Release preparation is incomplete; rerun its original Merge job before retrying publication",
            })
          ),
    complete: (release) =>
      Effect.sync(() => {
        outcome.completed.push(release.id);
      }),
    reservedCanaryVersions: () =>
      Effect.succeed(
        [...byTag.values()]
          .filter((saved) => saved.intent.channel === "canary")
          .map((saved) => saved.intent.version)
      ),
  };

  const npm = {
    publish: (_archive: string) =>
      Effect.sync(() => {
        if (verified === undefined) throw new Error("expected a verified release");
        outcome.published.push(verified.version);
        registry.versions.set(verified.version, { commit: verified.commit, integrity: verified.integrity });
      }),
    promote: (version: string, tag: string) =>
      Effect.sync(() => {
        outcome.promoted.push({ version, tag });
        registry.tags.set(tag, version);
      }),
  };

  const git: GitPort = {
    head: () => Effect.succeed(commit),
    originMain: () => Effect.succeed(commit),
    isClean: () => Effect.succeed(true),
    stableVersionAt: () => Effect.succeed("0.1.9"),
    ...options.git,
  };

  const deps: EngineDeps = {
    git,
    ancestry: options.isAncestor ?? linearHistory,
    store,
    readRegistry: () => Effect.succeed(registry),
    npm,
    confirmationInterval: 0,
    stableGate: () => Effect.succeed(options.line ?? canaryLine),
    plannedCanaryBase: () => Effect.succeed(options.base ?? "0.2.0"),
    verifyArchive: (intent, bytes) => {
      outcome.verified.push({ intent, bytes });
      verified = { ...intent, archive: "/verified/release.tgz", integrity: "sha512-test" };
      return Effect.succeed(verified);
    },
    log: (message) => {
      outcome.logs.push(message);
    },
  };

  const adapter: PackAndVerify = { pack: vi.fn(() => packedArchive) };
  return { deps, adapter, outcome, store, registry };
}

function runMain(commitSha: string, deps: EngineDeps, adapter: PackAndVerify): Promise<void> {
  return Effect.runPromise(executeCheckedCommit(pkg, adapter, commitSha, deps).pipe(Effect.scoped));
}

function runRetry(tag: string, deps: EngineDeps): Promise<void> {
  return Effect.runPromise(executeRetry(pkg, tag, deps).pipe(Effect.scoped));
}

function canaryIntent(version: string): ReleaseIntent {
  return { channel: "canary", version, commit };
}

describe("main release preconditions", () => {
  it("refuses a checkout that is not the checked commit", async () => {
    const { deps, adapter, outcome } = harness({ git: { head: () => Effect.succeed(newerCommit) } });
    await expect(runMain(commit, deps, adapter)).rejects.toThrow("Checkout differs from the checked commit");
    expect(outcome.created).toEqual([]);
  });

  it("refuses a commit that is not on main", async () => {
    const { deps, adapter, outcome } = harness({ isAncestor: () => false });
    await expect(runMain(commit, deps, adapter)).rejects.toThrow("Release source is not on main");
    expect(outcome.created).toEqual([]);
  });

  it("refuses a dirty checkout", async () => {
    const { deps, adapter, outcome } = harness({ git: { isClean: () => Effect.succeed(false) } });
    await expect(runMain(commit, deps, adapter)).rejects.toThrow("Release requires a clean checkout");
    expect(outcome.created).toEqual([]);
  });
});

describe("main release plan execution", () => {
  it("records, uploads, publishes, and promotes a stable release", async () => {
    const { deps, adapter, outcome } = harness({ line: stableLine });
    await runMain(commit, deps, adapter);
    expect(outcome.created).toEqual([{ channel: "stable", version: "0.2.0", commit }]);
    expect(outcome.uploaded).toEqual([packedArchive]);
    expect(outcome.published).toEqual(["0.2.0"]);
    expect(outcome.promoted).toEqual([{ version: "0.2.0", tag: "latest" }]);
    expect(outcome.completed).toEqual([1]);
  });

  it("prefers a stable version bump over a canary record for the same commit", async () => {
    const canary: ReleaseIntent = { channel: "canary", version: "0.2.0-canary.11", commit };
    const { deps, adapter, outcome } = harness({
      line: stableLine,
      seed: [{ id: 4, intent: canary, asset: { state: "uploaded", id: 2 } }],
    });
    await runMain(commit, deps, adapter);
    expect(outcome.created).toEqual([{ channel: "stable", version: "0.2.0", commit }]);
    expect(outcome.published).toEqual(["0.2.0"]);
    expect(outcome.uploaded).toEqual([packedArchive]);
  });

  it("resumes a saved canary record from its downloaded archive", async () => {
    const intent: ReleaseIntent = { channel: "canary", version: "0.2.0-canary.11", commit };
    const { deps, adapter, outcome } = harness({
      seed: [{ id: 4, intent, asset: { state: "uploaded", id: 2 } }],
    });
    await runMain(commit, deps, adapter);
    expect(outcome.created).toEqual([]);
    expect(outcome.verified).toEqual([{ intent, bytes: storedArchive }]);
    expect(outcome.uploaded).toEqual([]);
    expect(outcome.published).toEqual(["0.2.0-canary.11"]);
    expect(outcome.completed).toEqual([4]);
  });

  it("skips a commit superseded by a published canary", async () => {
    const { deps, adapter, outcome } = harness({
      registry: {
        versions: new Map([["0.2.0-canary.12", { commit: newerCommit, integrity: "newer" }]]),
        tags: new Map(),
      },
    });
    await runMain(commit, deps, adapter);
    expect(outcome.created).toEqual([]);
    expect(outcome.published).toEqual([]);
    expect(outcome.logs).toContain("Skipping a commit superseded by a published canary");
  });

  it("skips a commit superseded by a stable release", async () => {
    const { deps, adapter, outcome } = harness({
      registry: {
        versions: new Map([["0.2.0", { commit: newerCommit, integrity: "stable" }]]),
        tags: new Map(),
      },
    });
    await runMain(commit, deps, adapter);
    expect(outcome.created).toEqual([]);
    expect(outcome.published).toEqual([]);
    expect(outcome.logs).toContain("Skipping a commit superseded by a stable release");
  });

  it("skips a planned base older than a canary on a newer base", async () => {
    const { deps, adapter, outcome } = harness({
      registry: {
        versions: new Map([["0.3.0-canary.0", { integrity: "published" }]]),
        tags: new Map(),
      },
    });
    await runMain(commit, deps, adapter);
    expect(outcome.created).toEqual([]);
    expect(outcome.published).toEqual([]);
    expect(outcome.logs).toContain("Skipping a commit superseded by a canary on a newer base");
  });

  it("allocates after reserved canary versions", async () => {
    const reserved: SavedRelease = {
      id: 8,
      intent: { channel: "canary", version: "0.2.0-canary.13", commit: "d".repeat(40) },
      asset: { state: "missing" },
    };
    const { deps, adapter, outcome } = harness({
      seed: [reserved],
      registry: {
        versions: new Map([["0.2.0-canary.12", { integrity: "legacy" }]]),
        tags: new Map(),
      },
    });
    await runMain(commit, deps, adapter);
    expect(outcome.created).toEqual([canaryIntent("0.2.0-canary.14")]);
    expect(outcome.uploaded).toEqual([packedArchive]);
    expect(outcome.published).toEqual(["0.2.0-canary.14"]);
  });

  it("surfaces a pack failure without publishing", async () => {
    const { deps, adapter, outcome } = harness({ line: stableLine });
    const failure = new Error("build failed");
    adapter.pack = vi.fn(() => {
      throw failure;
    });
    const error = await Effect.runPromise(
      Effect.flip(executeCheckedCommit(pkg, adapter, commit, deps).pipe(Effect.scoped))
    );
    expect(error).toMatchObject({ _tag: "ReleaseError", message: "build failed" });
    expect(error.cause).toBe(failure);
    expect(outcome.published).toEqual([]);
  });
});

describe("retry and finish", () => {
  it("refuses retry of an incomplete record", async () => {
    const intent: ReleaseIntent = { channel: "stable", version: "0.2.0", commit };
    const { deps, outcome } = harness({
      seed: [{ id: 1, intent, asset: { state: "missing" } }],
    });
    await expect(runRetry("v0.2.0", deps)).rejects.toThrow("original Merge job");
    expect(outcome.verified).toEqual([]);
    expect(outcome.published).toEqual([]);
    expect(outcome.completed).toEqual([]);
  });

  it("finishes a prepared record from its downloaded archive", async () => {
    const intent: ReleaseIntent = { channel: "canary", version: "0.2.0-canary.11", commit };
    const { deps, outcome } = harness({
      seed: [{ id: 4, intent, asset: { state: "uploaded", id: 2 } }],
    });
    await runRetry(canaryRecordTag(commit), deps);
    expect(outcome.verified).toEqual([{ intent, bytes: storedArchive }]);
    expect(outcome.uploaded).toEqual([]);
    expect(outcome.published).toEqual(["0.2.0-canary.11"]);
    expect(outcome.completed).toEqual([4]);
  });

  it("does not complete a superseded canary", async () => {
    const intent: ReleaseIntent = { channel: "canary", version: "0.2.0-canary.11", commit };
    const { deps, outcome } = harness({
      seed: [{ id: 4, intent, asset: { state: "uploaded", id: 2 } }],
      registry: {
        versions: new Map([["0.2.0-canary.12", { commit: newerCommit, integrity: "newer" }]]),
        tags: new Map(),
      },
    });
    await runRetry(canaryRecordTag(commit), deps);
    expect(outcome.published).toEqual([]);
    expect(outcome.completed).toEqual([]);
    expect(outcome.logs).toContain(
      "Skipping superseded canary 0.2.0-canary.11; its draft record remains reserved"
    );
  });

  it("refuses a record tag that has no prepared release", async () => {
    const { deps, outcome } = harness();
    await expect(runRetry("v9.9.9", deps)).rejects.toThrow("No prepared release exists for that tag");
    expect(outcome.verified).toEqual([]);
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
        message: "GitHub repository and token are required",
      });
    });
  });

  it("constructs releaseCheckedCommit without credentials and fails with ReleaseError when executed", async () => {
    await withMissingGitHubCredentials(async () => {
      const effect = releaseCheckedCommit(missingCheckout, { pack: () => packedArchive }, commit);
      await expect(Effect.runPromise(effect)).rejects.toMatchObject({
        _tag: "ReleaseError",
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
      const operations = createReleaseOperations(() => environment);
      await expect(Effect.runPromise(operations.retryRelease(pkg, "v0.2.0"))).rejects.toThrow(
        "GitHub GET failed: 404"
      );
      expect(requested[0]).toContain("/releases?per_page=100");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
