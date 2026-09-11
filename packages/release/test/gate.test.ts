import { Effect } from "effect";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createStableReleaseGate } from "../src/gate.ts";
import { createGitHubClient } from "../src/github.ts";

const commit = "a".repeat(40);

const mergedReleasePull = {
  merged_at: "2026-09-09",
  merge_commit_sha: commit,
  head: { ref: "changeset-release/main", repo: { full_name: "example/package" } },
  base: { ref: "main" },
};

type CheckoutOptions = {
  version?: string;
  changelog?: string;
  pendingChangeset?: boolean;
};

/** A disposable stand-in for the release checkout the gate reads. */
function withCheckout(
  options: CheckoutOptions,
  run: (root: string, packageDirectory: string) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "elmera-release-gate-"));
  const packageDirectory = resolve(root, "packages/internal");
  const version = options.version ?? "0.2.0";
  mkdirSync(packageDirectory, { recursive: true });
  mkdirSync(resolve(root, ".changeset"), { recursive: true });
  writeFileSync(resolve(packageDirectory, "package.json"), JSON.stringify({ name: "@acme/app", version }));
  writeFileSync(
    resolve(packageDirectory, "CHANGELOG.md"),
    `# changelog\n\n## ${options.changelog ?? version}\n`
  );
  writeFileSync(resolve(root, ".changeset/README.md"), "ignored\n");
  if (options.pendingChangeset === true) writeFileSync(resolve(root, ".changeset/pending.md"), "pending\n");
  return run(root, packageDirectory).finally(() => {
    rmSync(root, { recursive: true, force: true });
  });
}

/** Records every GitHub URL the gate reaches for, so unreached checks are visible. */
function gitHub(pulls: readonly unknown[]) {
  const requested: string[] = [];
  const client = createGitHubClient({
    repository: "example/package",
    token: "test",
    fetch: (url) => {
      const path = url instanceof URL ? url.href : url instanceof Request ? url.url : url;
      requested.push(path);
      if (path.includes("/pulls")) return Promise.resolve(Response.json(pulls));
      return Promise.resolve(new Response("", { status: 500 }));
    },
  });
  return { client, requested };
}

describe("stable release gate", () => {
  it("reports the canary line when the manifest still matches the previous commit", async () => {
    await withCheckout({ version: "0.2.0" }, async (root, packageDirectory) => {
      const { client, requested } = gitHub([mergedReleasePull]);
      await expect(
        Effect.runPromise(createStableReleaseGate(client, root, packageDirectory, "main")(commit, "0.2.0"))
      ).resolves.toEqual({
        channel: "canary",
        current: "0.2.0",
      });
      expect(requested).toEqual([]);
    });
  });

  it("reports the stable line once the files and the merged PR both check out", async () => {
    await withCheckout({ version: "0.2.0" }, async (root, packageDirectory) => {
      const { client, requested } = gitHub([mergedReleasePull]);
      await expect(
        Effect.runPromise(createStableReleaseGate(client, root, packageDirectory, "main")(commit, "0.1.9"))
      ).resolves.toEqual({
        channel: "stable",
        version: "0.2.0",
      });
      expect(requested).toHaveLength(1);
    });
  });

  it("checks the release files before asking GitHub about the pull request", async () => {
    await withCheckout({ version: "0.2.0", pendingChangeset: true }, async (root, packageDirectory) => {
      const { client, requested } = gitHub([mergedReleasePull]);
      await expect(
        Effect.runPromise(createStableReleaseGate(client, root, packageDirectory, "main")(commit, "0.1.9"))
      ).rejects.toThrow("did not consume all changesets");
      expect(requested).toEqual([]);
    });
  });

  it("refuses a manifest version that is missing from the changelog", async () => {
    await withCheckout({ version: "0.2.0", changelog: "0.1.9" }, async (root, packageDirectory) => {
      const { client, requested } = gitHub([mergedReleasePull]);
      await expect(
        Effect.runPromise(createStableReleaseGate(client, root, packageDirectory, "main")(commit, "0.1.9"))
      ).rejects.toThrow("missing from the changelog");
      expect(requested).toEqual([]);
    });
  });

  it("refuses a manifest version that moves backward", async () => {
    await withCheckout({ version: "0.1.8" }, async (root, packageDirectory) => {
      const { client } = gitHub([mergedReleasePull]);
      await expect(
        Effect.runPromise(createStableReleaseGate(client, root, packageDirectory, "main")(commit, "0.1.9"))
      ).rejects.toThrow("Stable version must increase");
    });
  });

  it("refuses a manifest version that is not a stable release version", async () => {
    await withCheckout({ version: "0.2.0-canary.3" }, async (root, packageDirectory) => {
      const { client } = gitHub([mergedReleasePull]);
      await expect(
        Effect.runPromise(createStableReleaseGate(client, root, packageDirectory, "main")(commit, "0.1.9"))
      ).rejects.toThrow("Expected a stable version");
    });
  });

  it.each([
    { merged_at: null },
    { merge_commit_sha: "b".repeat(40) },
    { head: { ref: "feature", repo: { full_name: "example/package" } } },
    { head: { ref: "changeset-release/main", repo: { full_name: "fork/package" } } },
    { base: { ref: "release" } },
  ])("rejects a version change without the approved release PR", async (override) => {
    await withCheckout({ version: "0.2.0" }, async (root, packageDirectory) => {
      const { client } = gitHub([{ ...mergedReleasePull, ...override }]);
      await expect(
        Effect.runPromise(createStableReleaseGate(client, root, packageDirectory, "main")(commit, "0.1.9"))
      ).rejects.toThrow("merged changeset-release/main PR");
    });
  });

  it("uses the tracked branch for the release PR", async () => {
    const pull = {
      ...mergedReleasePull,
      head: { ref: "changeset-release/develop", repo: { full_name: "example/package" } },
      base: { ref: "develop" },
    };
    await withCheckout({ version: "0.2.0" }, async (root, packageDirectory) => {
      const { client } = gitHub([pull]);
      await expect(
        Effect.runPromise(createStableReleaseGate(client, root, packageDirectory, "develop")(commit, "0.1.9"))
      ).resolves.toEqual({
        channel: "stable",
        version: "0.2.0",
      });
    });
    await withCheckout({ version: "0.2.0" }, async (root, packageDirectory) => {
      const { client } = gitHub([mergedReleasePull]);
      await expect(
        Effect.runPromise(createStableReleaseGate(client, root, packageDirectory, "develop")(commit, "0.1.9"))
      ).rejects.toThrow("merged changeset-release/develop PR");
    });
  });
});
