import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createReleaseOperations, releaseCheckedCommit, retryRelease } from "../src/engine.ts";
import type { ReleaseError } from "../src/errors.ts";
import type { ReleasePackage } from "../src/files.ts";
import type { CommitSha, ReleaseIntent } from "../src/intent.ts";
import { canaryRecordTag, parseIntent, releaseTag, serializeIntent } from "../src/record.ts";
import { withCheckout } from "./lib/checkout.ts";
import type { Checkout, PlannedReleaseFixture } from "./lib/checkout.ts";
import { withMissingGitHubCredentials } from "./lib/environment.ts";
import { archiveIntegrity, createFakeRemote } from "./lib/fake-remote.ts";
import type { FakeRemote } from "./lib/fake-remote.ts";
import { workspaceTimeout } from "./lib/git-workspace.ts";
import { packArchive, recordingPacker } from "./lib/packed-archive.ts";
import { commit, commitSha, releaseIntent } from "./lib/release-fixtures.ts";

const repository = "acme/app";
const packageName = "@acme/app";
const githubApi = `https://api.github.com/repos/${repository}`;
const releaseListing = `${githubApi}/releases?per_page=100&page=1`;

/** Changesets plans the next minor, so a fresh canary counts up from `0.2.0`. */
const minorPlan: readonly PlannedReleaseFixture[] = [
  { name: packageName, type: "minor", newVersion: "0.2.0" },
];

function fakeRemote(): FakeRemote {
  return createFakeRemote(repository, packageName);
}

function operations(remote: FakeRemote) {
  return createReleaseOperations(() => remote.environment);
}

function failure(effect: Effect.Effect<void, ReleaseError>): Promise<ReleaseError> {
  return Effect.runPromise(Effect.flip(effect));
}

/** The checked commit and a descendant the tracked branch has moved on to. */
type LinearHistory = {
  readonly checked: CommitSha;
  readonly descendant: CommitSha;
};

/**
 * Commits the checked commit and one descendant on the baseline, points the tracked branch at the
 * descendant, and detaches at the checked commit, as the Publish Release checkout does.
 */
function linearHistory(checkout: Checkout): LinearHistory {
  checkout.writeFile("packages/app/README.md", "checked\n");
  const checked = checkout.commit("checked");
  checkout.writeFile("packages/app/README.md", "descendant\n");
  const descendant = checkout.commit("descendant");
  checkout.setTrackedTip(descendant);
  checkout.detach(checked);
  return { checked, descendant };
}

/**
 * Lands a changeset, then merges the generated release PR that consumes it, bumps the manifest to
 * `0.2.0`, and names the version in the changelog. GitHub reports the merge as the release PR's
 * merge commit on `trackedBranch`.
 */
function mergeReleasePr(checkout: Checkout, remote: FakeRemote, trackedBranch = "main"): CommitSha {
  checkout.addChangeset("feature");
  checkout.commit("feature");
  checkout.consumeChangeset("feature");
  checkout.writeVersion("0.2.0");
  checkout.writeChangelog("0.2.0", "0.1.9");
  const merge = checkout.commit("Version Packages");
  checkout.setTrackedTip(merge);
  checkout.detach(merge);
  remote.seedPull(merge, {
    merged_at: "2026-10-01T00:00:00Z",
    merge_commit_sha: merge,
    head: { ref: `changeset-release/${trackedBranch}`, repo: { full_name: repository } },
    base: { ref: trackedBranch },
  });
  return merge;
}

/** Seeds a record for `intent` with its tag; `attached` uploads a real archive and returns it. */
function seedRecord(remote: FakeRemote, intent: ReleaseIntent, archive: "attached" | "missing"): Uint8Array {
  const bytes = packArchive(packageName, intent);
  remote.seedTag(releaseTag(intent), intent.commit);
  remote.seedRelease({
    tag: releaseTag(intent),
    body: serializeIntent(intent),
    assets: archive === "attached" ? [{ bytes }] : [],
  });
  return bytes;
}

/**
 * Asserts only the orderings that protect publication: the tag ref and draft record exist before
 * the archive upload, the upload precedes `npm publish`, `npm publish` precedes `dist-tag add`, the
 * record-completing PATCH follows `dist-tag add`, and nothing mutates GitHub after that PATCH.
 */
function expectPublicationOrder(remote: FakeRemote, repo: string, recordId: number): void {
  const api = `https://api.github.com/repos/${repo}`;
  const uploads = `https://uploads.github.com/repos/${repo}`;
  const { timeline } = remote;
  const first = (event: string): number => {
    const index = timeline.findIndex((entry) => entry.startsWith(event));
    expect(index, event).toBeGreaterThanOrEqual(0);
    return index;
  };
  const tagRef = first(`POST ${api}/git/refs`);
  const draft = first(`POST ${api}/releases`);
  const upload = first(`POST ${uploads}/releases/${String(recordId)}/assets`);
  const publish = first("npm publish ");
  const distTag = first("npm dist-tag add ");
  const complete = first(`PATCH ${api}/releases/${String(recordId)}`);
  expect(tagRef).toBeLessThan(upload);
  expect(draft).toBeLessThan(upload);
  expect(upload).toBeLessThan(publish);
  expect(publish).toBeLessThan(distTag);
  expect(distTag).toBeLessThan(complete);
  expect(
    timeline
      .slice(complete + 1)
      .filter((entry) => /^(?:POST|PATCH|PUT|DELETE) https:\/\/(?:api|uploads)\.github\.com\//u.test(entry))
  ).toEqual([]);
}

function recordedIntent(remote: FakeRemote, tag: string): ReleaseIntent {
  return parseIntent(remote.release(tag).body ?? "");
}

function recordedArchive(remote: FakeRemote, tag: string): Uint8Array | undefined {
  return remote.release(tag).assets.find((asset) => asset.name === "release.tgz")?.bytes;
}

describe("checked-commit preconditions", () => {
  it(
    "refuses a checkout that is not the checked commit and names both commits",
    async () => {
      await withCheckout({ plan: minorPlan }, async (checkout) => {
        const remote = fakeRemote();
        const packer = recordingPacker(packageName);
        const { checked, descendant } = linearHistory(checkout);
        checkout.detach(descendant);
        const error = await failure(
          operations(remote).releaseCheckedCommit(checkout.pkg, packer.adapter, checked)
        );
        expect(error.message).toBe(`Checkout ${descendant} differs from the checked commit ${checked}`);
        expect(remote.requests).toEqual([]);
        expect(packer.packed).toEqual([]);
      });
    },
    workspaceTimeout
  );

  it(
    "refuses a commit that is not an ancestor of the tracked branch tip",
    async () => {
      await withCheckout({ plan: minorPlan }, async (checkout) => {
        const remote = fakeRemote();
        const packer = recordingPacker(packageName);
        const baseline = checkout.head();
        checkout.writeFile("packages/app/README.md", "main\n");
        const tip = checkout.commit("main");
        checkout.setTrackedTip(tip);
        checkout.detach(baseline);
        checkout.writeFile("packages/app/README.md", "side\n");
        const side = checkout.commit("side");
        const error = await failure(
          operations(remote).releaseCheckedCommit(checkout.pkg, packer.adapter, side)
        );
        expect(error.message).toBe(
          `Release source ${side} is not an ancestor of the tracked branch tip ${tip}`
        );
        expect(remote.requests).toEqual([]);
        expect(packer.packed).toEqual([]);
      });
    },
    workspaceTimeout
  );

  it(
    "refuses a dirty checkout",
    async () => {
      await withCheckout({ plan: minorPlan }, async (checkout) => {
        const remote = fakeRemote();
        const packer = recordingPacker(packageName);
        const { checked } = linearHistory(checkout);
        checkout.writeFile("packages/app/README.md", "uncommitted\n");
        const error = await failure(
          operations(remote).releaseCheckedCommit(checkout.pkg, packer.adapter, checked)
        );
        expect(error.message).toBe("Release requires a clean checkout");
        expect(remote.requests).toEqual([]);
        expect(packer.packed).toEqual([]);
      });
    },
    workspaceTimeout
  );
});

describe("checked-commit plan execution", () => {
  it(
    "records, uploads, publishes, and promotes a stable release",
    async () => {
      await withCheckout({}, async (checkout) => {
        const remote = fakeRemote();
        const packer = recordingPacker(packageName);
        const merge = mergeReleasePr(checkout, remote);
        await Effect.runPromise(operations(remote).releaseCheckedCommit(checkout.pkg, packer.adapter, merge));
        expect(packer.packed).toHaveLength(1);
        const [packed] = packer.packed;
        expect(recordedIntent(remote, "v0.2.0")).toEqual({
          channel: "stable",
          version: "0.2.0",
          commit: merge,
        });
        expect(remote.tag("v0.2.0")).toBe(merge);
        expect(recordedArchive(remote, "v0.2.0")).toEqual(packed);
        expect(remote.published.map(({ version, integrity, tag }) => ({ version, integrity, tag }))).toEqual([
          { version: "0.2.0", integrity: archiveIntegrity(packed ?? new Uint8Array()), tag: "pending" },
        ]);
        expect(remote.promoted).toEqual([{ version: "0.2.0", tag: "latest" }]);
        expect(remote.release("v0.2.0").draft).toBe(false);
        expect(remote.logs).toContain(`Released ${packageName}@0.2.0 from ${merge}. Record: v0.2.0`);
        expect(remote.npmCalls.map(({ cwd, args }) => ({ cwd, command: args.slice(0, 2) }))).toEqual([
          { cwd: checkout.pkg.checkoutRoot, command: ["publish", expect.stringMatching(/archive\.tgz$/u)] },
          { cwd: checkout.pkg.checkoutRoot, command: ["dist-tag", "add"] },
        ]);
        expectPublicationOrder(remote, repository, remote.release("v0.2.0").id);
      });
    },
    workspaceTimeout
  );

  it(
    "prefers a stable version bump over a canary record for the same commit",
    async () => {
      await withCheckout({}, async (checkout) => {
        const remote = fakeRemote();
        const packer = recordingPacker(packageName);
        const merge = mergeReleasePr(checkout, remote);
        const canaryArchive = seedRecord(remote, releaseIntent("0.2.0-canary.11", merge), "attached");
        await Effect.runPromise(operations(remote).releaseCheckedCommit(checkout.pkg, packer.adapter, merge));
        expect(recordedIntent(remote, "v0.2.0")).toEqual({
          channel: "stable",
          version: "0.2.0",
          commit: merge,
        });
        expect(packer.packed).toHaveLength(1);
        expect(recordedArchive(remote, "v0.2.0")).toEqual(packer.packed[0]);
        expect(remote.published.map(({ version }) => version)).toEqual(["0.2.0"]);
        expect(recordedArchive(remote, canaryRecordTag(merge))).toEqual(canaryArchive);
        expect(remote.release(canaryRecordTag(merge)).draft).toBe(true);
      });
    },
    workspaceTimeout
  );

  it(
    "resumes a saved canary record from its downloaded archive",
    async () => {
      await withCheckout({ plan: minorPlan }, async (checkout) => {
        const remote = fakeRemote();
        const packer = recordingPacker(packageName);
        const { checked } = linearHistory(checkout);
        const tag = canaryRecordTag(checked);
        const stored = seedRecord(remote, releaseIntent("0.2.0-canary.11", checked), "attached");
        const recordId = remote.release(tag).id;
        await Effect.runPromise(
          operations(remote).releaseCheckedCommit(checkout.pkg, packer.adapter, checked)
        );
        expect(packer.packed).toEqual([]);
        expect(remote.mutations()).toEqual([`PATCH ${githubApi}/releases/${String(recordId)}`]);
        expect(remote.published.map(({ version, integrity }) => ({ version, integrity }))).toEqual([
          { version: "0.2.0-canary.11", integrity: archiveIntegrity(stored) },
        ]);
        expect(remote.promoted).toEqual([{ version: "0.2.0-canary.11", tag: "canary" }]);
        expect(remote.release(tag).draft).toBe(false);
      });
    },
    workspaceTimeout
  );

  it(
    "skips a commit superseded by a published canary",
    async () => {
      await withCheckout({ plan: minorPlan }, async (checkout) => {
        const remote = fakeRemote();
        const packer = recordingPacker(packageName);
        const { checked, descendant } = linearHistory(checkout);
        remote.seedVersion("0.2.0-canary.12", { commit: descendant, integrity: "sha512-newer" });
        await Effect.runPromise(
          operations(remote).releaseCheckedCommit(checkout.pkg, packer.adapter, checked)
        );
        expect(remote.mutations()).toEqual([]);
        expect(packer.packed).toEqual([]);
        expect(remote.npmCalls).toEqual([]);
        expect(remote.logs).toContain("Skipping a commit superseded by a published canary");
      });
    },
    workspaceTimeout
  );

  it(
    "skips a commit superseded by a stable release",
    async () => {
      await withCheckout({ plan: minorPlan }, async (checkout) => {
        const remote = fakeRemote();
        const packer = recordingPacker(packageName);
        const { checked, descendant } = linearHistory(checkout);
        remote.seedVersion("0.2.0", { commit: descendant, integrity: "sha512-stable" });
        await Effect.runPromise(
          operations(remote).releaseCheckedCommit(checkout.pkg, packer.adapter, checked)
        );
        expect(remote.mutations()).toEqual([]);
        expect(packer.packed).toEqual([]);
        expect(remote.npmCalls).toEqual([]);
        expect(remote.logs).toContain("Skipping a commit superseded by a stable release");
      });
    },
    workspaceTimeout
  );

  it(
    "skips a planned base older than a canary on a newer base",
    async () => {
      await withCheckout({ plan: minorPlan }, async (checkout) => {
        const remote = fakeRemote();
        const packer = recordingPacker(packageName);
        const { checked } = linearHistory(checkout);
        remote.seedVersion("0.3.0-canary.0", { integrity: "sha512-published" });
        await Effect.runPromise(
          operations(remote).releaseCheckedCommit(checkout.pkg, packer.adapter, checked)
        );
        expect(remote.mutations()).toEqual([]);
        expect(packer.packed).toEqual([]);
        expect(remote.npmCalls).toEqual([]);
        expect(remote.logs).toContain("Skipping a commit superseded by a canary on a newer base");
      });
    },
    workspaceTimeout
  );

  it(
    "numbers after reserved canary versions",
    async () => {
      await withCheckout({ plan: minorPlan }, async (checkout) => {
        const remote = fakeRemote();
        const packer = recordingPacker(packageName);
        const { checked } = linearHistory(checkout);
        seedRecord(remote, releaseIntent("0.2.0-canary.13", commitSha("d")), "missing");
        remote.seedVersion("0.2.0-canary.12", { integrity: "sha512-legacy" });
        await Effect.runPromise(
          operations(remote).releaseCheckedCommit(checkout.pkg, packer.adapter, checked)
        );
        const tag = canaryRecordTag(checked);
        expect(recordedIntent(remote, tag)).toEqual(releaseIntent("0.2.0-canary.14", checked));
        expect(packer.packed).toHaveLength(1);
        expect(recordedArchive(remote, tag)).toEqual(packer.packed[0]);
        expect(remote.published.map(({ version }) => version)).toEqual(["0.2.0-canary.14"]);
      });
    },
    workspaceTimeout
  );

  it(
    "surfaces a pack failure without publishing",
    async () => {
      await withCheckout({ plan: minorPlan }, async (checkout) => {
        const remote = fakeRemote();
        const { checked } = linearHistory(checkout);
        const cause = new Error("build failed");
        const error = await failure(
          operations(remote).releaseCheckedCommit(
            checkout.pkg,
            {
              pack: () => {
                throw cause;
              },
            },
            checked
          )
        );
        expect(error).toMatchObject({ _tag: "ReleaseError", message: "build failed" });
        expect(error.cause).toBe(cause);
        expect(remote.npmCalls).toEqual([]);
        expect(remote.count("POST", "/assets")).toBe(0);
        expect(remote.release(canaryRecordTag(checked)).assets).toEqual([]);
      });
    },
    workspaceTimeout
  );
});

describe("retry and completion", () => {
  it(
    "refuses retry of an incomplete record",
    async () => {
      await withCheckout({}, async (checkout) => {
        const remote = fakeRemote();
        const { checked } = linearHistory(checkout);
        seedRecord(remote, releaseIntent("0.2.0", checked), "missing");
        const error = await failure(operations(remote).retryRelease(checkout.pkg, "v0.2.0"));
        const incomplete =
          "Release preparation is incomplete; rerun its original Merge job before retrying publication";
        expect(error.message).toBe(incomplete);
        expect(error.cause).toBeInstanceOf(Error);
        expect(error.cause).toMatchObject({ message: incomplete });
        expect(remote.mutations()).toEqual([]);
        expect(remote.count("GET", "/releases/assets/")).toBe(0);
        expect(remote.npmCalls).toEqual([]);
      });
    },
    workspaceTimeout
  );

  it(
    "finishes a prepared record from its downloaded archive",
    async () => {
      await withCheckout({}, async (checkout) => {
        const remote = fakeRemote();
        const { checked } = linearHistory(checkout);
        const tag = canaryRecordTag(checked);
        const stored = seedRecord(remote, releaseIntent("0.2.0-canary.11", checked), "attached");
        const recordId = remote.release(tag).id;
        await Effect.runPromise(operations(remote).retryRelease(checkout.pkg, tag));
        expect(remote.mutations()).toEqual([`PATCH ${githubApi}/releases/${String(recordId)}`]);
        expect(remote.published.map(({ version, integrity }) => ({ version, integrity }))).toEqual([
          { version: "0.2.0-canary.11", integrity: archiveIntegrity(stored) },
        ]);
        expect(remote.release(tag).draft).toBe(false);
      });
    },
    workspaceTimeout
  );

  it(
    "does not complete a superseded canary",
    async () => {
      await withCheckout({}, async (checkout) => {
        const remote = fakeRemote();
        const { checked, descendant } = linearHistory(checkout);
        const tag = canaryRecordTag(checked);
        seedRecord(remote, releaseIntent("0.2.0-canary.11", checked), "attached");
        remote.seedVersion("0.2.0-canary.12", { commit: descendant, integrity: "sha512-newer" });
        await Effect.runPromise(operations(remote).retryRelease(checkout.pkg, tag));
        expect(remote.npmCalls).toEqual([]);
        expect(remote.mutations()).toEqual([]);
        expect(remote.release(tag).draft).toBe(true);
        expect(remote.logs).toContain(
          "Skipping superseded canary 0.2.0-canary.11; its draft record remains reserved"
        );
      });
    },
    workspaceTimeout
  );

  it(
    "refuses a record tag that has no prepared release and names the tag",
    async () => {
      await withCheckout({}, async (checkout) => {
        const remote = fakeRemote();
        const error = await failure(operations(remote).retryRelease(checkout.pkg, "v9.9.9"));
        expect(error.message).toBe("No prepared release exists for record tag v9.9.9");
        expect(remote.mutations()).toEqual([]);
        expect(remote.count("GET", "/releases/assets/")).toBe(0);
      });
    },
    workspaceTimeout
  );

  it(
    "completes a record only after its publication succeeds",
    async () => {
      await withCheckout({ plan: minorPlan }, async (checkout) => {
        const remote = fakeRemote();
        const packer = recordingPacker(packageName);
        const { checked } = linearHistory(checkout);
        const tag = canaryRecordTag(checked);
        remote.failNextNpm("dist-tag", "E401 Unable to authenticate");
        const error = await failure(
          operations(remote).releaseCheckedCommit(checkout.pkg, packer.adapter, checked)
        );
        expect(error.message).toBe("npm failed with status 1: E401 Unable to authenticate");
        expect(remote.count("PATCH", "/releases/")).toBe(0);
        expect(remote.release(tag).draft).toBe(true);
        expect(recordedArchive(remote, tag)).toEqual(packer.packed[0]);

        await Effect.runPromise(operations(remote).retryRelease(checkout.pkg, tag));
        expect(packer.packed).toHaveLength(1);
        expect(remote.published.map(({ version }) => version)).toEqual(["0.2.0-canary.0"]);
        expect(remote.promoted).toEqual([{ version: "0.2.0-canary.0", tag: "canary" }]);
        expect(remote.mutations().at(-1)).toBe(
          `PATCH ${githubApi}/releases/${String(remote.release(tag).id)}`
        );
        expect(remote.release(tag).draft).toBe(false);
      });
    },
    workspaceTimeout
  );

  it(
    "does not complete a prepared record when npm holds different bytes for its version",
    async () => {
      await withCheckout({}, async (checkout) => {
        const remote = fakeRemote();
        const { checked } = linearHistory(checkout);
        const tag = canaryRecordTag(checked);
        seedRecord(remote, releaseIntent("0.2.0-canary.11", checked), "attached");
        remote.seedVersion("0.2.0-canary.11", { commit: checked, integrity: "sha512-other" });
        const error = await failure(operations(remote).retryRelease(checkout.pkg, tag));
        expect(error.message).toBe("npm 0.2.0-canary.11 does not match the recorded archive and commit");
        expect(remote.mutations()).toEqual([]);
        expect(remote.npmCalls).toEqual([]);
        expect(remote.release(tag).draft).toBe(true);
      });
    },
    workspaceTimeout
  );
});

describe("tracked branch wiring", () => {
  it(
    "checks the release PR against the tracked branch without its origin/ prefix",
    async () => {
      await withCheckout({ trackedBranch: "develop" }, async (checkout) => {
        const remote = fakeRemote();
        const packer = recordingPacker(packageName);
        const merge = mergeReleasePr(checkout, remote, "develop");
        await Effect.runPromise(operations(remote).releaseCheckedCommit(checkout.pkg, packer.adapter, merge));
        expect(remote.count("GET", `/commits/${merge}/pulls?per_page=100`)).toBe(1);
        expect(remote.promoted).toEqual([{ version: "0.2.0", tag: "latest" }]);
        expect(remote.release("v0.2.0").draft).toBe(false);
      });
    },
    workspaceTimeout
  );

  it(
    "refuses a release PR merged into a branch other than the tracked one",
    async () => {
      await withCheckout({ trackedBranch: "develop" }, async (checkout) => {
        const remote = fakeRemote();
        const packer = recordingPacker(packageName);
        const merge = mergeReleasePr(checkout, remote, "main");
        const error = await failure(
          operations(remote).releaseCheckedCommit(checkout.pkg, packer.adapter, merge)
        );
        expect(error.message).toBe(
          "A stable version change must come from a merged changeset-release/develop PR"
        );
        expect(remote.mutations()).toEqual([]);
        expect(packer.packed).toEqual([]);
      });
    },
    workspaceTimeout
  );
});

const missingCheckout: ReleasePackage = {
  checkoutRoot: "/missing-checkout",
  packageDirectory: "/missing-checkout/packages/app",
  packageName,
};

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
      const effect = releaseCheckedCommit(missingCheckout, { pack: () => new Uint8Array([1, 2, 3]) }, commit);
      await expect(Effect.runPromise(effect)).rejects.toMatchObject({
        _tag: "ReleaseError",
        message: "GitHub repository and token are required",
      });
    });
  });

  it(
    "threads an injected environment into the live transport",
    async () => {
      await withCheckout({}, async (checkout) => {
        const remote = fakeRemote();
        remote.override("GET", releaseListing, () => new Response("", { status: 404 }));
        const error = await failure(operations(remote).retryRelease(checkout.pkg, "v0.2.0"));
        expect(error.message).toBe(`GitHub GET failed: 404 ${releaseListing}`);
        expect(remote.requests[0]?.url).toBe(releaseListing);
      });
    },
    workspaceTimeout
  );

  it(
    "retries a prepared record without the Changesets config that retry does not read",
    async () => {
      await withCheckout({}, async (checkout) => {
        const remote = fakeRemote();
        const { checked } = linearHistory(checkout);
        const tag = canaryRecordTag(checked);
        seedRecord(remote, releaseIntent("0.2.0-canary.11", checked), "attached");
        checkout.removeFile(".changeset/config.json");
        await Effect.runPromise(operations(remote).retryRelease(checkout.pkg, tag));
        expect(remote.release(tag).draft).toBe(false);
        const error = await failure(
          operations(remote).releaseCheckedCommit(checkout.pkg, recordingPacker(packageName).adapter, checked)
        );
        expect(error.message).toContain(".changeset/config.json");
      });
    },
    workspaceTimeout
  );
});

describe("recorded canary publication", () => {
  it(
    "publishes the packed archive end to end through a recorded GitHub release",
    async () => {
      const uiRepository = "acme/ui";
      const uiPackage = "@acme/ui";
      await withCheckout({ packageName: uiPackage, version: "0.1.0" }, async (checkout) => {
        const remote = createFakeRemote(uiRepository, uiPackage);
        const packer = recordingPacker(uiPackage);
        checkout.writeFile("packages/app/README.md", "ui\n");
        const head = checkout.commit("head");
        checkout.setTrackedTip(head);
        const tag = canaryRecordTag(head);

        await Effect.runPromise(operations(remote).releaseCheckedCommit(checkout.pkg, packer.adapter, head));

        expect(packer.packed).toHaveLength(1);
        const [packed] = packer.packed;
        expect(remote.npmCalls).toEqual([
          {
            cwd: checkout.pkg.checkoutRoot,
            args: [
              "publish",
              expect.stringMatching(/archive\.tgz$/u),
              "--access",
              "public",
              "--tag",
              "pending",
              "--ignore-scripts",
            ],
          },
          {
            cwd: checkout.pkg.checkoutRoot,
            args: ["dist-tag", "add", `${uiPackage}@0.1.1-canary.0`, "canary"],
          },
        ]);
        expect(recordedArchive(remote, tag)).toEqual(packed);
        expect(remote.release(tag).draft).toBe(false);
        expect(remote.release(tag).body).toContain("elmera-release");
        expect(remote.tag(tag)).toBe(head);
        expect(remote.version("0.1.1-canary.0")).toEqual({
          commit: head,
          integrity: archiveIntegrity(packed ?? new Uint8Array()),
        });
        expect(remote.distTags().get("canary")).toBe("0.1.1-canary.0");
        expectPublicationOrder(remote, uiRepository, remote.release(tag).id);
      });
    },
    workspaceTimeout
  );
});
