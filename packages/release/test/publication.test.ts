import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ReleaseError } from "../src/errors.ts";
import { assertCommit } from "../src/intent.ts";
import type { VerifiedRelease } from "../src/intent.ts";
import type { Registry } from "../src/npm.ts";
import type { CommitAncestry } from "../src/policy.ts";
import { publishVerifiedRelease } from "../src/publication.ts";
import type { PublicationDeps } from "../src/publication.ts";
import { assertCanaryReleaseVersion, assertStableReleaseVersion } from "../src/version.ts";

const commit = assertCommit("a".repeat(40));
const newerCommit = assertCommit("b".repeat(40));
const unrelatedCommit = assertCommit("c".repeat(40));
const release: VerifiedRelease = {
  channel: "canary",
  version: assertCanaryReleaseVersion("0.2.0-canary.11"),
  commit,
  archive: "/verified/release.tgz",
  integrity: "sha512-test",
};

const commitsToNewer: CommitAncestry = (ancestor, descendant) =>
  ancestor === commit && descendant === newerCommit;

/**
 * In-memory publication harness. Publish and promote mutate the registry the way npm would, and
 * the returned arrays record which archive and dist-tag actually went out.
 */
function publication(target: VerifiedRelease = release) {
  const registry: Registry = { versions: new Map(), tags: new Map() };
  const publishes: string[] = [];
  const promotions: { version: string; tag: string }[] = [];
  const deps: PublicationDeps = {
    readRegistry: () => Effect.succeed(registry),
    npm: {
      publish: (archive) =>
        Effect.sync(() => {
          publishes.push(archive);
          registry.versions.set(target.version, {
            commit: target.commit,
            integrity: target.integrity,
          });
        }),
      promote: (version, tag) =>
        Effect.sync(() => {
          promotions.push({ version, tag });
          registry.tags.set(tag, version);
        }),
    },
    confirmationInterval: 0,
    ancestry: commitsToNewer,
  };
  return { registry, publishes, promotions, deps };
}

function publish(target: VerifiedRelease, deps: PublicationDeps) {
  return Effect.runPromise(publishVerifiedRelease(target, deps));
}

describe("verified publication", () => {
  it("uploads the verified archive then promotes after checking npm identity", async () => {
    const { registry, publishes, promotions, deps } = publication();
    await expect(publish(release, deps)).resolves.toBe("published");
    expect(publishes).toEqual([release.archive]);
    expect(registry.versions.get(release.version)).toEqual({ commit, integrity: release.integrity });
    expect(promotions).toEqual([{ version: release.version, tag: "canary" }]);
    expect(registry.tags.get("canary")).toBe(release.version);
  });

  it("waits until the dist-tag is visible after a successful promote", async () => {
    const { registry, deps } = publication();
    let pendingTag: { version: string; tag: string } | undefined;
    let registryReads = 0;
    deps.readRegistry = () =>
      Effect.sync(() => {
        registryReads += 1;
        const tags = new Map(registry.tags);
        if (registryReads >= 3 && pendingTag !== undefined) tags.set(pendingTag.tag, pendingTag.version);
        return { versions: new Map(registry.versions), tags };
      });
    deps.npm.promote = (version, tag) => {
      pendingTag = { version, tag };
      return Effect.void;
    };
    await expect(publish(release, deps)).resolves.toBe("published");
    expect(pendingTag).toEqual({ version: release.version, tag: "canary" });
    expect(registryReads).toBeGreaterThanOrEqual(3);
  });

  it("recovers when npm accepted the upload but the client reported failure", async () => {
    const { registry, deps } = publication();
    deps.npm.publish = () => {
      registry.versions.set(release.version, { commit, integrity: release.integrity });
      return Effect.fail(new ReleaseError({ message: "connection lost" }));
    };
    await expect(publish(release, deps)).resolves.toBe("published");
    expect(registry.versions.get(release.version)).toEqual({ commit, integrity: release.integrity });
    expect(registry.tags.get("canary")).toBe(release.version);
  });

  it("retries without uploading an already verified version", async () => {
    const { registry, publishes, deps } = publication();
    registry.versions.set(release.version, { commit, integrity: release.integrity });
    await expect(publish(release, deps)).resolves.toBe("published");
    expect(publishes).toEqual([]);
    expect(registry.tags.get("canary")).toBe(release.version);
  });

  it.each([
    { commit, integrity: "sha512-other" },
    { commit: newerCommit, integrity: release.integrity },
  ])("rejects an existing version with different identity", async (existing) => {
    const { registry, publishes, promotions, deps } = publication();
    registry.versions.set(release.version, existing);
    await expect(publish(release, deps)).rejects.toThrow("does not match");
    expect(publishes).toEqual([]);
    expect(promotions).toEqual([]);
  });

  it("does not promote an unverified upload and retains the npm error", async () => {
    const { registry, deps } = publication();
    const npmError = new ReleaseError({ message: "connection lost" });
    deps.npm.publish = () => Effect.fail(npmError);
    const failure = await Effect.runPromise(Effect.flip(publishVerifiedRelease(release, deps)));
    expect(failure).toMatchObject({
      _tag: "ReleaseError",
      message: "Publication could not be verified; retry the recorded release",
    });
    expect(failure.cause).toBe(npmError);
    expect(registry.versions.has(release.version)).toBe(false);
    expect(registry.tags.has("canary")).toBe(false);
  });

  it("does not replace a newer canary even when the delayed version has a larger suffix", async () => {
    const { registry, publishes, promotions, deps } = publication();
    registry.versions.set("0.2.0-canary.10", { commit: newerCommit, integrity: "other" });
    registry.tags.set("canary", "0.2.0-canary.10");
    await expect(publish(release, deps)).resolves.toBe("superseded");
    expect(publishes).toEqual([]);
    expect(promotions).toEqual([]);
    expect(registry.tags.get("canary")).toBe("0.2.0-canary.10");
  });

  it.each(["missing", "older", "already-uploaded"])(
    "blocks an older retry when a newer canary is pending: %s",
    async (state) => {
      const { registry, publishes, promotions, deps } = publication();
      registry.versions.set("0.2.0-canary.12", { commit: newerCommit, integrity: "newer" });
      registry.tags.set("pending", "0.2.0-canary.12");
      if (state === "older") {
        registry.versions.set("0.2.0-canary.10", { commit: unrelatedCommit, integrity: "older" });
        registry.tags.set("canary", "0.2.0-canary.10");
        deps.ancestry = (ancestor, descendant) =>
          ancestor === unrelatedCommit || (ancestor === commit && descendant === newerCommit);
      }
      if (state === "already-uploaded") {
        registry.versions.set(release.version, { commit, integrity: release.integrity });
      }
      // An already published version is reported as published but neither uploaded nor promoted;
      // a version that npm never accepted is superseded outright.
      await expect(publish(release, deps)).resolves.toBe(
        state === "already-uploaded" ? "published" : "superseded"
      );
      expect(publishes).toEqual([]);
      expect(promotions).toEqual([]);
    }
  );

  it("rechecks all published canaries before promotion", async () => {
    const { registry, publishes, promotions, deps } = publication();
    deps.npm.publish = (archive) => {
      publishes.push(archive);
      registry.versions.set(release.version, { commit, integrity: release.integrity });
      registry.versions.set("0.2.0-canary.12", { commit: newerCommit, integrity: "newer" });
      return Effect.void;
    };
    await expect(publish(release, deps)).resolves.toBe("published");
    expect(publishes).toHaveLength(1);
    expect(promotions).toEqual([]);
    expect(registry.tags.has("canary")).toBe(false);
  });

  it("skips a prepared canary once its stable base has shipped", async () => {
    const { registry, publishes, promotions, deps } = publication();
    registry.versions.set("0.2.0", { commit: newerCommit, integrity: "stable" });
    await expect(publish(release, deps)).resolves.toBe("superseded");
    expect(publishes).toEqual([]);
    expect(promotions).toEqual([]);
    expect([...registry.versions.keys()]).toEqual(["0.2.0"]);
  });

  it("publishes an older stable retry without moving latest backwards", async () => {
    const stable: VerifiedRelease = {
      channel: "stable",
      version: assertStableReleaseVersion("0.1.9"),
      commit,
      archive: release.archive,
      integrity: release.integrity,
    };
    const { registry, publishes, promotions, deps } = publication(stable);
    registry.versions.set("0.2.0", { commit: newerCommit, integrity: "newer" });
    registry.tags.set("latest", "0.2.0");
    await expect(publish(stable, deps)).resolves.toBe("published");
    expect(publishes).toEqual([stable.archive]);
    expect(promotions).toEqual([]);
    expect(registry.tags.get("latest")).toBe("0.2.0");
    expect(registry.versions.get(stable.version)).toEqual({ commit, integrity: stable.integrity });
  });
});

describe("registry integrity", () => {
  it("diagnoses missing integrity on the candidate version only", async () => {
    const { registry, publishes, promotions, deps } = publication();
    registry.versions.set("0.1.0", { commit: newerCommit });
    registry.versions.set(release.version, { commit });
    await expect(publish(release, deps)).rejects.toThrow("missing dist integrity");
    expect(publishes).toEqual([]);
    expect(promotions).toEqual([]);
  });

  it("still publishes when an unrelated historical version lacks integrity", async () => {
    const { registry, publishes, deps } = publication();
    registry.versions.set("0.1.0", { commit: unrelatedCommit });
    await expect(publish(release, deps)).resolves.toBe("published");
    expect(publishes).toEqual([release.archive]);
  });
});
