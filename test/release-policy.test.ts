import { describe, expect, it } from "vitest";

import { allocateCanary, canaryEligibility, distTagFor, planPublication } from "../scripts/release-policy.ts";
import type { CommitAncestry } from "../scripts/release-policy.ts";
import type { ReleaseIntent, VerifiedRelease } from "../scripts/release-record.ts";
import type { Registry } from "../scripts/release-registry.ts";

const commit = "a".repeat(40);
const newerCommit = "b".repeat(40);
const unrelatedCommit = "c".repeat(40);
const canaryIntent: ReleaseIntent = { channel: "canary", version: "0.2.0-canary.11", commit };
const canary: VerifiedRelease = {
  ...canaryIntent,
  archive: "/verified/package.tgz",
  integrity: "sha512-test",
};
const stable: VerifiedRelease = {
  channel: "stable",
  version: "0.1.9",
  commit,
  archive: "/verified/package.tgz",
  integrity: "sha512-test",
};

function registry(): Registry {
  return { versions: new Map(), tags: new Map() };
}

const isAncestor: CommitAncestry = (ancestor, descendant) =>
  ancestor === commit && descendant === newerCommit;

type CanaryPlanOptions = {
  current?: string;
  commit?: string;
  registry?: Registry;
  reserved?: readonly string[];
  plannedBase?: string;
  ancestry?: CommitAncestry;
};

function eligibility(options: CanaryPlanOptions = {}) {
  return canaryEligibility(
    {
      commit: options.commit ?? commit,
      current: options.current ?? "0.1.9",
      base: options.plannedBase ?? "0.2.0",
    },
    options.registry ?? registry(),
    options.ancestry ?? isAncestor
  );
}

/** The whole canary decision the pipeline makes: eligibility first, then version allocation. */
function canaryPlan(options: CanaryPlanOptions = {}) {
  const decision = eligibility(options);
  if (decision !== "eligible") return decision;
  const published = options.registry ?? registry();
  return allocateCanary(options.plannedBase ?? "0.2.0", [
    ...published.versions.keys(),
    ...(options.reserved ?? []),
  ]);
}

function publicationPlan(release: VerifiedRelease, published: Registry, ancestry = isAncestor) {
  return planPublication(release, published, ancestry);
}

describe("fresh canary plan", () => {
  it("allocates a fresh canary when no record exists", () => {
    expect(canaryPlan()).toBe("0.2.0-canary.0");
  });

  it("skips when a published stable is greater than the checked-out manifest version", () => {
    const published = registry();
    published.versions.set("0.1.2", { commit: newerCommit, integrity: "stable" });
    expect(canaryPlan({ current: "0.1.1", registry: published })).toBe("stable-superseded");
    expect(
      canaryPlan({
        current: "0.1.1",
        registry: {
          versions: new Map([
            ["0.1.1", { integrity: "stable" }],
            ["0.1.1-canary.9", { integrity: "canary" }],
          ]),
          tags: new Map(),
        },
      })
    ).toBe("0.2.0-canary.0");
    expect(
      canaryPlan({
        current: "0.1.1",
        registry: { versions: new Map([["0.1.0", { integrity: "stable" }]]), tags: new Map() },
      })
    ).toBe("0.2.0-canary.0");
  });

  it("reuses the same ancestry skip before allocating a new canary", () => {
    const published = registry();
    published.versions.set("0.2.0-canary.12", { commit: newerCommit, integrity: "newer" });
    expect(canaryPlan({ registry: published })).toBe("canary-superseded");
    expect(() => canaryPlan({ commit: newerCommit, registry: published })).toThrow("record is missing");
  });

  it("ignores published canaries that have no source commit", () => {
    const published = registry();
    published.versions.set("0.2.0-canary.1", { integrity: "legacy" });
    expect(canaryPlan({ registry: published })).toBe("0.2.0-canary.2");
  });

  it("throws on mixed descendant and divergent canaries regardless of map order", () => {
    const descendantFirst = registry();
    descendantFirst.versions.set("0.2.0-canary.12", { commit: newerCommit, integrity: "newer" });
    descendantFirst.versions.set("0.2.0-canary.13", { commit: unrelatedCommit, integrity: "unrelated" });
    const divergentFirst = registry();
    divergentFirst.versions.set("0.2.0-canary.13", { commit: unrelatedCommit, integrity: "unrelated" });
    divergentFirst.versions.set("0.2.0-canary.12", { commit: newerCommit, integrity: "newer" });
    for (const published of [descendantFirst, divergentFirst]) {
      expect(() => canaryPlan({ registry: published })).toThrow("diverged");
      expect(() => publicationPlan(canary, published)).toThrow("diverged");
    }
  });

  it("supersedes when any descendant exists and the rest of history is linear", () => {
    const published = registry();
    published.versions.set("0.2.0-canary.12", { commit: newerCommit, integrity: "newer" });
    published.versions.set("0.2.0-canary.14", { commit: newerCommit, integrity: "also-newer" });
    expect(canaryPlan({ registry: published })).toBe("canary-superseded");
    expect(publicationPlan(canary, published)).toEqual({ kind: "superseded" });
  });
});

describe("recorded canary retry", () => {
  it("skips once a published stable is greater than or equal to the recorded canary base", () => {
    const covers = registry();
    covers.versions.set("0.2.0", { integrity: "stable" });
    expect(publicationPlan(canary, covers)).toEqual({ kind: "superseded" });
    const older = registry();
    older.versions.set("0.1.9", { integrity: "stable" });
    expect(publicationPlan(canary, older).kind).not.toBe("superseded");
    const later = registry();
    later.versions.set("0.2.1", { integrity: "stable" });
    expect(publicationPlan(canary, later)).toEqual({ kind: "superseded" });
    const sibling = registry();
    sibling.versions.set("0.1.9", { integrity: "stable" });
    sibling.versions.set("0.2.0-canary.12", { integrity: "canary" });
    expect(publicationPlan(canary, sibling).kind).not.toBe("superseded");
  });

  it("uses the published version for this commit when checking ancestry on retry", () => {
    const published = registry();
    published.versions.set("0.2.0-canary.12", { commit: newerCommit, integrity: "newer" });
    expect(publicationPlan(canary, published)).toEqual({ kind: "superseded" });
    expect(
      publicationPlan(
        { ...canary, commit: newerCommit, version: "0.2.0-canary.12", integrity: "newer" },
        published
      )
    ).toEqual({ kind: "publish", upload: false, promote: true });
  });
});

describe("publication plan", () => {
  it("lets a stable retry upload without moving latest backward", () => {
    const published = registry();
    published.versions.set("0.2.0", { commit: newerCommit, integrity: "newer" });
    published.tags.set("latest", "0.2.0");
    expect(publicationPlan(stable, published)).toEqual({ kind: "publish", upload: true, promote: false });
  });

  it("does not upload a new canary once its stable base has shipped", () => {
    const published = registry();
    published.versions.set("0.2.0", { commit: newerCommit, integrity: "stable" });
    expect(publicationPlan(canary, published)).toEqual({ kind: "superseded" });
  });

  it("does not upload a new canary superseded by a later published canary commit", () => {
    const published = registry();
    published.versions.set("0.2.0-canary.12", { commit: newerCommit, integrity: "newer" });
    expect(publicationPlan(canary, published)).toEqual({ kind: "superseded" });
  });

  it("uploads and advances when the canary still owns the channel", () => {
    expect(publicationPlan(canary, registry())).toEqual({ kind: "publish", upload: true, promote: true });
  });

  it("allows the first stable release to replace the legacy canary on latest", () => {
    const published = registry();
    published.tags.set("latest", "0.1.1-canary.1");
    expect(publicationPlan({ ...stable, version: "0.1.2" }, published)).toEqual({
      kind: "publish",
      upload: true,
      promote: true,
    });
    published.tags.set("latest", "0.1.3");
    expect(publicationPlan({ ...stable, version: "0.1.2" }, published)).toEqual({
      kind: "publish",
      upload: true,
      promote: false,
    });
  });

  it("only advances a legacy canary without commit metadata", () => {
    const published = registry();
    published.tags.set("canary", "0.1.1-canary.1");
    expect(publicationPlan(canary, published)).toEqual({ kind: "publish", upload: true, promote: true });
    published.tags.set("canary", "0.3.0-canary.1");
    expect(publicationPlan(canary, published)).toEqual({ kind: "publish", upload: true, promote: false });
  });

  it("advances a canary tag whose current version has a source commit", () => {
    const published = registry();
    published.versions.set("0.2.0-canary.10", { commit, integrity: "older" });
    published.tags.set("canary", "0.2.0-canary.10");
    const later = { ...canary, commit: newerCommit, version: "0.2.0-canary.9" };
    expect(publicationPlan(later, published)).toEqual({ kind: "publish", upload: true, promote: true });
  });

  it("rejects divergent source history", () => {
    const published = registry();
    published.tags.set("canary", "0.2.0-canary.10");
    published.versions.set("0.2.0-canary.10", { commit: newerCommit, integrity: "other" });
    expect(() => publicationPlan(canary, published, () => false)).toThrow("diverged");
  });

  it("rejects a retry whose recorded version differs from the published canary for that commit", () => {
    const published = registry();
    published.versions.set("0.2.0-canary.12", { commit, integrity: "published" });
    expect(() => publicationPlan(canary, published)).toThrow("different canary version");
  });

  it("promotes an already uploaded version that does not yet own the channel tag", () => {
    const published = registry();
    published.versions.set(canary.version, { commit, integrity: canary.integrity });
    expect(publicationPlan(canary, published)).toEqual({ kind: "publish", upload: false, promote: true });
  });

  it("is a noop when the version is already on npm and already owns the tag", () => {
    const published = registry();
    published.versions.set(canary.version, { commit, integrity: canary.integrity });
    published.tags.set("canary", canary.version);
    expect(publicationPlan(canary, published)).toEqual({ kind: "publish", upload: false, promote: false });
  });

  it("rejects an existing version with a conflicting identity", () => {
    const published = registry();
    published.versions.set(canary.version, { commit, integrity: "sha512-other" });
    expect(() => publicationPlan(canary, published)).toThrow("does not match");
    published.versions.set(canary.version, { commit: newerCommit, integrity: canary.integrity });
    expect(() => publicationPlan(canary, published)).toThrow("does not match");
  });

  it("maps channel names onto npm dist-tags", () => {
    expect(distTagFor("canary")).toBe("canary");
    expect(distTagFor("stable")).toBe("latest");
  });
});

describe("canary numbering policy", () => {
  it("refuses a planned base that does not advance the checked-out version", () => {
    expect(() => canaryPlan({ current: "0.2.0", plannedBase: "0.2.0" })).toThrow(
      "must advance the stable version"
    );
  });

  it("refuses a canary base that is older than an already published canary", () => {
    const published = registry();
    published.versions.set("0.3.0-canary.0", { integrity: "published" });
    expect(() => canaryPlan({ registry: published })).toThrow("older than");
  });

  it("skips a stable release that already reaches the planned base", () => {
    const published = registry();
    published.versions.set("0.2.0", { integrity: "published" });
    expect(canaryPlan({ registry: published })).toBe("stable-superseded");
  });

  it("skips a later published stable instead of allocating against it", () => {
    const published = registry();
    published.versions.set("0.3.0", { integrity: "published" });
    expect(canaryPlan({ current: "0.2.0", plannedBase: "0.2.1", registry: published })).toBe(
      "stable-superseded"
    );
  });

  it("allocates after the policy accepts the base", () => {
    const published = registry();
    published.versions.set("0.1.9", { integrity: "stable" });
    published.versions.set("0.2.0-canary.12", { integrity: "canary" });
    expect(canaryPlan({ registry: published, reserved: ["0.2.0-canary.13"] })).toBe("0.2.0-canary.14");
  });
});
