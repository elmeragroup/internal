import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { verifyPackedArchive } from "../scripts/packed-verification.ts";

const packageName = "@elmeragroup/internal";

/**
 * @typedef {{
 *   directory: string;
 *   archivePath: string;
 *   bytesA: Buffer;
 *   bytesB: Buffer;
 * }} Fixture
 */

/**
 * @param {(fixture: Fixture) => void} run
 */
function withFixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "elmera-packed-verification-"));
  try {
    const bytesA = Buffer.from("archive-a");
    const bytesB = Buffer.from("archive-b");
    const archivePath = join(directory, "elmeragroup-internal-0.1.0-canary.1.tgz");
    writeFileSync(archivePath, bytesA);
    run({ directory, archivePath, bytesA, bytesB });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("packed verification", () => {
  it("runs checks against a private snapshot that is removed afterwards", () => {
    withFixture(({ directory, archivePath, bytesA }) => {
      /** @type {string | undefined} */
      let snapshotPath;
      verifyPackedArchive(archivePath, packageName, (path) => {
        snapshotPath = path;
        expect(path.startsWith(directory)).toBe(false);
        expect(readFileSync(path).equals(bytesA)).toBe(true);
      });
      if (snapshotPath === undefined) throw new Error("expected a snapshot path");
      expect(existsSync(snapshotPath)).toBe(false);
    });
  });

  it("does not let a replaced archive B pass verification of A", () => {
    withFixture(({ archivePath, bytesB }) => {
      expect(() =>
        verifyPackedArchive(archivePath, packageName, () => {
          writeFileSync(archivePath, bytesB);
        })
      ).toThrow(/archive changed since verification/);
    });
  });

  it("propagates failed checks and removes the snapshot", () => {
    withFixture(({ archivePath }) => {
      /** @type {string | undefined} */
      let snapshotPath;
      expect(() =>
        verifyPackedArchive(archivePath, packageName, (path) => {
          snapshotPath = path;
          expect(existsSync(path)).toBe(true);
          throw new Error("checks failed");
        })
      ).toThrow(/checks failed/);
      if (snapshotPath === undefined) throw new Error("expected a snapshot path");
      expect(existsSync(snapshotPath)).toBe(false);
    });
  });
});
