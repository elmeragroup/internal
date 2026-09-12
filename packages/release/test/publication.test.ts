import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ReleaseError } from "../src/errors.ts";
import type { VerifiedRelease } from "../src/intent.ts";
import type { Registry } from "../src/npm.ts";
import { publishVerifiedRelease } from "../src/publication.ts";
import type { PublicationDeps } from "../src/publication.ts";

const commit = "a".repeat(40);
const newerCommit = "b".repeat(40);
const release: VerifiedRelease = {
  channel: "canary",
  version: "0.2.0-canary.11",
  commit,
  archive: "/verified/release.tgz",
  integrity: "sha512-test",
};

function publication() {
  const registry: Registry = { versions: new Map(), tags: new Map() };
  const deps = {
    readRegistry: (): Effect.Effect<Registry, ReleaseError> => Effect.succeed(registry),
    npm: {
      publish: vi.fn((_archive: string): Effect.Effect<void, ReleaseError> =>
        Effect.sync(() => {
          registry.versions.set(release.version, { commit, integrity: release.integrity });
        })
      ),
      promote: vi.fn((version: string, tag: string): Effect.Effect<void, ReleaseError> =>
        Effect.sync(() => {
          registry.tags.set(tag, version);
        })
      ),
    },
    confirmationInterval: 0,
    ancestry: vi.fn(
      (ancestor: string, descendant: string): boolean => ancestor === commit && descendant === newerCommit
    ),
  } satisfies PublicationDeps;
  return { registry, deps };
}

function publish(target: VerifiedRelease, deps: PublicationDeps) {
  return Effect.runPromise(publishVerifiedRelease(target, deps));
}

describe("verified publication", () => {
  it("uploads the verified archive then promotes after checking npm identity", async () => {
    const { deps } = publication();
    await publish(release, deps);
    expect(deps.npm.publish).toHaveBeenCalledWith(release.archive);
    expect(deps.npm.promote).toHaveBeenCalledWith(release.version, "canary");
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
    deps.npm.promote.mockImplementation((version: string, tag: string) =>
      Effect.sync(() => {
        pendingTag = { version, tag };
      })
    );
    await publish(release, deps);
    expect(deps.npm.promote).toHaveBeenCalledTimes(1);
    expect(deps.npm.promote).toHaveBeenCalledWith(release.version, "canary");
    expect(registryReads).toBeGreaterThanOrEqual(3);
  });

  it("recovers when npm accepted the upload but the client reported failure", async () => {
    const { registry, deps } = publication();
    deps.npm.publish.mockImplementation(() => {
      registry.versions.set(release.version, { commit, integrity: release.integrity });
      return Effect.fail(new ReleaseError({ message: "connection lost" }));
    });
    await publish(release, deps);
    expect(deps.npm.publish).toHaveBeenCalledTimes(1);
    expect(deps.npm.promote).toHaveBeenCalled();
  });

  it("retries without uploading an already verified version", async () => {
    const { registry, deps } = publication();
    registry.versions.set(release.version, { commit, integrity: release.integrity });
    await publish(release, deps);
    expect(deps.npm.publish).not.toHaveBeenCalled();
    expect(deps.npm.promote).toHaveBeenCalled();
  });

  it.each([
    { commit, integrity: "sha512-other" },
    { commit: newerCommit, integrity: release.integrity },
  ])("rejects an existing version with different identity", async (existing) => {
    const { registry, deps } = publication();
    registry.versions.set(release.version, existing);
    await expect(publish(release, deps)).rejects.toThrow("does not match");
    expect(deps.npm.promote).not.toHaveBeenCalled();
    expect(deps.npm.publish).not.toHaveBeenCalled();
  });

  it("does not promote an unverified upload and retains the npm error", async () => {
    const { deps } = publication();
    const npmError = new ReleaseError({ message: "connection lost" });
    deps.npm.publish.mockImplementation(() => Effect.fail(npmError));
    const failure = await Effect.runPromise(Effect.flip(publishVerifiedRelease(release, deps)));
    expect(failure).toMatchObject({
      _tag: "ReleaseError",
      message: "Publication could not be verified; retry the recorded release",
    });
    expect(failure.cause).toBe(npmError);
    expect(deps.npm.publish).toHaveBeenCalledTimes(1);
    expect(deps.npm.promote).not.toHaveBeenCalled();
  });

  it("does not replace a newer canary even when the delayed version has a larger suffix", async () => {
    const { registry, deps } = publication();
    registry.versions.set("0.2.0-canary.10", { commit: newerCommit, integrity: "other" });
    registry.tags.set("canary", "0.2.0-canary.10");
    await publish(release, deps);
    expect(deps.npm.promote).not.toHaveBeenCalled();
  });

  it.each(["missing", "older", "already-uploaded"])(
    "blocks an older retry when a newer canary is pending: %s",
    async (state) => {
      const { registry, deps } = publication();
      registry.versions.set("0.2.0-canary.12", { commit: newerCommit, integrity: "newer" });
      registry.tags.set("pending", "0.2.0-canary.12");
      if (state === "older") {
        const older = "c".repeat(40);
        registry.versions.set("0.2.0-canary.10", { commit: older, integrity: "older" });
        registry.tags.set("canary", "0.2.0-canary.10");
        deps.ancestry.mockImplementation(
          (ancestor, descendant) => ancestor === older || (ancestor === commit && descendant === newerCommit)
        );
      }
      if (state === "already-uploaded")
        registry.versions.set(release.version, { commit, integrity: release.integrity });
      await publish(release, deps);
      expect(deps.npm.publish).not.toHaveBeenCalled();
      expect(deps.npm.promote).not.toHaveBeenCalled();
    }
  );

  it("rechecks all published canaries before promotion", async () => {
    const { registry, deps } = publication();
    deps.npm.publish.mockImplementation(() => {
      registry.versions.set(release.version, { commit, integrity: release.integrity });
      registry.versions.set("0.2.0-canary.12", { commit: newerCommit, integrity: "newer" });
      return Effect.void;
    });
    await expect(publish(release, deps)).resolves.toBe("published");
    expect(deps.npm.publish).toHaveBeenCalledOnce();
    expect(deps.npm.promote).not.toHaveBeenCalled();
  });

  it("skips a prepared canary once its stable base has shipped", async () => {
    const { registry, deps } = publication();
    registry.versions.set("0.2.0", { commit: newerCommit, integrity: "stable" });
    await expect(publish(release, deps)).resolves.toBe("superseded");
    expect(deps.npm.publish).not.toHaveBeenCalled();
    expect(deps.npm.promote).not.toHaveBeenCalled();
  });

  it("publishes an older stable retry without moving latest backwards", async () => {
    const { registry, deps } = publication();
    const stable: VerifiedRelease = { ...release, channel: "stable", version: "0.1.9" };
    registry.versions.set("0.2.0", { commit: newerCommit, integrity: "newer" });
    registry.tags.set("latest", "0.2.0");
    deps.npm.publish.mockImplementation(() =>
      Effect.sync(() => {
        registry.versions.set(stable.version, { commit, integrity: stable.integrity });
      })
    );
    await expect(publish(stable, deps)).resolves.toBe("published");
    expect(deps.npm.publish).toHaveBeenCalledOnce();
    expect(deps.npm.promote).not.toHaveBeenCalled();
  });
});

describe("registry integrity", () => {
  it("diagnoses missing integrity on the candidate version only", async () => {
    const { registry, deps } = publication();
    registry.versions.set("0.1.0", { commit: newerCommit });
    registry.versions.set(release.version, { commit });
    await expect(publish(release, deps)).rejects.toThrow("missing dist integrity");
    expect(deps.npm.publish).not.toHaveBeenCalled();
  });

  it("still publishes when an unrelated historical version lacks integrity", async () => {
    const { registry, deps } = publication();
    registry.versions.set("0.1.0", { commit: "c".repeat(40) });
    await publish(release, deps);
    expect(deps.npm.publish).toHaveBeenCalledWith(release.archive);
  });
});
