import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { VerifiedRelease } from "../src/intent.ts";
import { publishVerifiedRelease } from "../src/publication.ts";
import type { PublicationServices } from "../src/publication.ts";
import type { Registry } from "../src/registry.ts";

const commit = "a".repeat(40);
const newerCommit = "b".repeat(40);
const release: VerifiedRelease = {
  channel: "canary",
  version: "0.2.0-canary.11",
  commit,
  archive: "/verified/package.tgz",
  integrity: "sha512-test",
};

function publication() {
  const registry: Registry = { versions: new Map(), tags: new Map() };
  const services = {
    registry: vi.fn(() => Promise.resolve(registry)),
    publish: vi.fn((_archive: string) => {
      registry.versions.set(release.version, { commit, integrity: release.integrity });
    }),
    promote: vi.fn((version: string, tag: string) => registry.tags.set(tag, version)),
    isAncestor: vi.fn(
      (ancestor: string, descendant: string) => ancestor === commit && descendant === newerCommit
    ),
    wait: vi.fn(() => Promise.resolve()),
  } satisfies PublicationServices;
  return { registry, services };
}

function publish(target: VerifiedRelease, services: PublicationServices) {
  return Effect.runPromise(publishVerifiedRelease(target, services));
}

describe("verified publication", () => {
  it("uploads the verified archive then promotes after checking npm identity", async () => {
    const { services } = publication();
    await publish(release, services);
    expect(services.publish).toHaveBeenCalledWith(release.archive);
    expect(services.promote).toHaveBeenCalledWith(release.version, "canary");
  });
  it("waits until the dist-tag is visible after a successful promote", async () => {
    const { services, registry } = publication();
    let pendingTag: { version: string; tag: string } | undefined;
    let tagVisible = false;
    services.promote.mockImplementation((version: string, tag: string) => {
      pendingTag = { version, tag };
    });
    services.registry.mockImplementation(() => {
      const tags = new Map(registry.tags);
      if (tagVisible && pendingTag !== undefined) {
        tags.set(pendingTag.tag, pendingTag.version);
      }
      return Promise.resolve({ versions: new Map(registry.versions), tags });
    });
    services.wait.mockImplementation(() => {
      if (pendingTag !== undefined) tagVisible = true;
      return Promise.resolve();
    });
    await publish(release, services);
    expect(services.promote).toHaveBeenCalledTimes(1);
    expect(services.promote).toHaveBeenCalledWith(release.version, "canary");
    expect(services.wait).toHaveBeenCalled();
  });
  it("recovers when npm accepted the upload but the client reported failure", async () => {
    const { services, registry } = publication();
    services.publish.mockImplementation(() => {
      registry.versions.set(release.version, { commit, integrity: release.integrity });
      throw new Error("connection lost");
    });
    await publish(release, services);
    expect(services.publish).toHaveBeenCalledTimes(1);
    expect(services.promote).toHaveBeenCalled();
  });
  it("retries without uploading an already verified version", async () => {
    const { services, registry } = publication();
    registry.versions.set(release.version, { commit, integrity: release.integrity });
    await publish(release, services);
    expect(services.publish).not.toHaveBeenCalled();
    expect(services.promote).toHaveBeenCalled();
  });
  it.each([
    { commit, integrity: "sha512-other" },
    { commit: newerCommit, integrity: release.integrity },
  ])("rejects an existing version with different identity", async (existing) => {
    const { services, registry } = publication();
    registry.versions.set(release.version, existing);
    await expect(publish(release, services)).rejects.toThrow("does not match");
    expect(services.promote).not.toHaveBeenCalled();
    expect(services.publish).not.toHaveBeenCalled();
  });
  it("does not promote an unverified upload and retains the npm error", async () => {
    const { services } = publication();
    services.publish.mockImplementation(() => {
      throw new Error("connection lost");
    });
    await expect(publish(release, services)).rejects.toMatchObject({
      _tag: "ReleaseError",
      message: "Publication could not be verified; retry the recorded release",
      cause: "connection lost",
    });
    expect(services.publish).toHaveBeenCalledTimes(1);
    expect(services.promote).not.toHaveBeenCalled();
  });
  it("does not replace a newer canary even when the delayed version has a larger suffix", async () => {
    const { services, registry } = publication();
    registry.versions.set("0.2.0-canary.10", { commit: newerCommit, integrity: "other" });
    registry.tags.set("canary", "0.2.0-canary.10");
    await publish(release, services);
    expect(services.promote).not.toHaveBeenCalled();
  });
  it.each(["missing", "older", "already-uploaded"])(
    "blocks an older retry when a newer canary is pending: %s",
    async (state) => {
      const { services, registry } = publication();
      registry.versions.set("0.2.0-canary.12", { commit: newerCommit, integrity: "newer" });
      registry.tags.set("pending", "0.2.0-canary.12");
      if (state === "older") {
        const older = "c".repeat(40);
        registry.versions.set("0.2.0-canary.10", { commit: older, integrity: "older" });
        registry.tags.set("canary", "0.2.0-canary.10");
        services.isAncestor.mockImplementation(
          (ancestor, descendant) => ancestor === older || (ancestor === commit && descendant === newerCommit)
        );
      }
      if (state === "already-uploaded")
        registry.versions.set(release.version, { commit, integrity: release.integrity });
      await publish(release, services);
      expect(services.publish).not.toHaveBeenCalled();
      expect(services.promote).not.toHaveBeenCalled();
    }
  );
  it("rechecks all published canaries before promotion", async () => {
    const { services, registry } = publication();
    services.publish.mockImplementation(() => {
      registry.versions.set(release.version, { commit, integrity: release.integrity });
      registry.versions.set("0.2.0-canary.12", { commit: newerCommit, integrity: "newer" });
    });
    await publish(release, services);
    expect(services.publish).toHaveBeenCalledOnce();
    expect(services.promote).not.toHaveBeenCalled();
  });
  it("skips a prepared canary once its stable base has shipped", async () => {
    const { services, registry } = publication();
    registry.versions.set("0.2.0", { commit: newerCommit, integrity: "stable" });
    await expect(publish(release, services)).resolves.toBe("superseded");
    expect(services.publish).not.toHaveBeenCalled();
    expect(services.promote).not.toHaveBeenCalled();
  });
  it("publishes an older stable retry without moving latest backwards", async () => {
    const { registry, services } = publication();
    const stable: VerifiedRelease = { ...release, channel: "stable", version: "0.1.9" };
    registry.versions.set("0.2.0", { commit: newerCommit, integrity: "newer" });
    registry.tags.set("latest", "0.2.0");
    services.publish.mockImplementation(() =>
      registry.versions.set(stable.version, { commit, integrity: stable.integrity })
    );
    await expect(publish(stable, services)).resolves.toBe("published");
    expect(services.publish).toHaveBeenCalledOnce();
    expect(services.promote).not.toHaveBeenCalled();
  });
});

describe("registry integrity", () => {
  it("diagnoses missing integrity on the candidate version only", async () => {
    const { services, registry } = publication();
    registry.versions.set("0.1.0", { commit: newerCommit });
    registry.versions.set(release.version, { commit });
    await expect(publish(release, services)).rejects.toThrow("missing dist integrity");
    expect(services.publish).not.toHaveBeenCalled();
  });
  it("still publishes when an unrelated historical version lacks integrity", async () => {
    const { services, registry } = publication();
    registry.versions.set("0.1.0", { commit: "c".repeat(40) });
    await publish(release, services);
    expect(services.publish).toHaveBeenCalledWith(release.archive);
  });
});
