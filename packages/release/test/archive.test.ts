import { Effect } from "effect";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { verifyReleaseArchive } from "../src/archive.ts";
import type { ReleaseIntent } from "../src/intent.ts";

const commit = "a".repeat(40);
const packageName = "@acme/app";
const intent: ReleaseIntent = { channel: "canary", version: "0.2.0-canary.1", commit };

type TestManifest = {
  name: string;
  version: string;
  elmeraRelease: { commit: string; channel: "canary" | "stable" };
  description?: string;
};

function validManifest(overrides: Partial<TestManifest> = {}): TestManifest {
  return {
    name: packageName,
    version: intent.version,
    elmeraRelease: { commit, channel: intent.channel },
    ...overrides,
  };
}

function archiveBytes(manifest: TestManifest | { name: string; version: string }): Uint8Array {
  const directoryName = "package";
  const directory = mkdtempSync(join(tmpdir(), "elmera-release-archive-"));
  try {
    mkdirSync(join(directory, directoryName), { recursive: true });
    writeFileSync(join(directory, directoryName, "package.json"), JSON.stringify(manifest));
    const archive = join(directory, "package.tgz");
    execFileSync("tar", ["-czf", archive, "-C", directory, directoryName]);
    return new Uint8Array(readFileSync(archive));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function verify(
  bytes: Uint8Array,
  target: ReleaseIntent = intent,
  name: string = packageName
): Promise<{ archive: string; integrity: string }> {
  return Effect.runPromise(verifyReleaseArchive(target, bytes, name).pipe(Effect.scoped));
}

describe("release archive verification", () => {
  it("accepts an archive whose manifest matches the recorded intent", async () => {
    const release = await verify(archiveBytes(validManifest()));
    expect(release.integrity).toMatch(/^sha512-/);
    expect(release.archive).toMatch(/release\.tgz$/);
  });

  it("materializes the archive inside the effect scope and removes it afterwards", async () => {
    let archivePath = "";
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const release = yield* verifyReleaseArchive(intent, archiveBytes(validManifest()), packageName);
          archivePath = release.archive;
          expect(existsSync(archivePath)).toBe(true);
        })
      )
    );
    expect(archivePath).not.toBe("");
    expect(existsSync(archivePath)).toBe(false);
  });

  it.each([
    ["package name", validManifest({ name: "@other/app" })],
    ["version", validManifest({ version: "0.3.0" })],
    [
      "commit",
      {
        ...validManifest(),
        elmeraRelease: { commit: "b".repeat(40), channel: intent.channel },
      },
    ],
    [
      "channel",
      {
        ...validManifest(),
        elmeraRelease: { commit, channel: "stable" },
      },
    ],
  ])("rejects an archive whose %s differs from the recorded intent", async (_label, manifest) => {
    await expect(verify(archiveBytes(manifest))).rejects.toThrow(
      "Archive does not match the recorded release source"
    );
  });

  it("rejects bytes that are not a package archive", async () => {
    await expect(verify(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });

  it("rejects a manifest that is missing the packed source", async () => {
    await expect(verify(archiveBytes({ name: packageName, version: intent.version }))).rejects.toThrow(
      "packed manifest is invalid"
    );
  });

  it("binds the integrity to the exact verified bytes", async () => {
    const firstBytes = archiveBytes(validManifest({ description: "one" }));
    const secondBytes = archiveBytes(validManifest({ description: "two" }));
    const first = await verify(firstBytes);
    const repeated = await verify(firstBytes);
    expect(repeated.integrity).toBe(first.integrity);
    const second = await verify(secondBytes);
    expect(second.integrity).not.toBe(first.integrity);
    const corrupted = new Uint8Array(firstBytes);
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
    await expect(verify(corrupted)).rejects.toThrow();
  });

  it("removes the scratch directory when verification fails", async () => {
    const prefix = "elmera-release-";
    const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)));
    await expect(verify(archiveBytes(validManifest({ name: "@other/app" })))).rejects.toThrow(
      "does not match"
    );
    const leftover = readdirSync(tmpdir()).filter((name) => name.startsWith(prefix) && !before.has(name));
    expect(leftover).toEqual([]);
  });
});
