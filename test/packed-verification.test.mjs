import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { validateReceipt, verifyPackedArchive } from "../scripts/packed-verification.ts";
import { packageName } from "../scripts/release.ts";
import { asRecord, readJsonObject } from "./json-object.mjs";

const version = "0.1.0-canary.1";

/**
 * @param {Buffer} bytes
 */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * @param {string} directory
 * @param {Buffer} bytes
 */
function writeArchive(directory, bytes) {
  const archiveFile = join(directory, `elmeragroup-internal-${version}.tgz`);
  const reportPath = join(directory, "archive.json");
  writeFileSync(archiveFile, bytes);
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        version,
        archive: {
          name: packageName,
          archive: archiveFile,
          bytes: bytes.length,
          sha256: sha256(bytes),
        },
      },
      null,
      2
    )}\n`
  );
  return {
    reportPath,
    archivePath: archiveFile,
    receiptPath: join(directory, "verified.json"),
    version,
  };
}

/**
 * @param {(fixture: {
 *   directory: string;
 *   inputs: ReturnType<typeof writeArchive>;
 *   bytesA: Buffer;
 *   bytesB: Buffer;
 * }) => void} run
 */
function withFixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "elmera-packed-verification-"));
  try {
    const bytesA = Buffer.from("archive-a");
    const bytesB = Buffer.from("archive-b");
    const inputs = writeArchive(directory, bytesA);
    run({ directory, inputs, bytesA, bytesB });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("packed verification", () => {
  it("writes a receipt for archive A that validateReceipt accepts", () => {
    withFixture(({ inputs }) => {
      let calls = 0;
      verifyPackedArchive(inputs, packageName, () => {
        calls += 1;
      });
      expect(calls).toBe(1);
      const receipt = readJsonObject(inputs.receiptPath);
      expect(receipt.status).toBe("pass");
      expect(receipt.version).toBe(version);
      expect(receipt.archiveReportSha256).toBe(sha256(readFileSync(inputs.reportPath)));
      expect(validateReceipt(inputs, packageName)).toBe(inputs.archivePath);
    });
  });

  it("runs checks against a private snapshot that is removed afterwards", () => {
    withFixture(({ directory, inputs, bytesA }) => {
      /** @type {string | undefined} */
      let snapshotPath;
      verifyPackedArchive(inputs, packageName, (path) => {
        snapshotPath = path;
        expect(path.startsWith(directory)).toBe(false);
        expect(readFileSync(path).equals(bytesA)).toBe(true);
      });
      expect(snapshotPath).toBeDefined();
      expect(existsSync(snapshotPath)).toBe(false);
    });
  });

  it.each([
    [
      "wrong sha256",
      /**
       * @param {ReturnType<typeof writeArchive>} inputs
       */
      (inputs) => {
        const report = readJsonObject(inputs.reportPath);
        asRecord(report.archive, "archive").sha256 = "0".repeat(64);
        writeFileSync(inputs.reportPath, `${JSON.stringify(report, null, 2)}\n`);
      },
    ],
    [
      "wrong byte count",
      /**
       * @param {ReturnType<typeof writeArchive>} inputs
       */
      (inputs) => {
        const report = readJsonObject(inputs.reportPath);
        asRecord(report.archive, "archive").bytes = 1;
        writeFileSync(inputs.reportPath, `${JSON.stringify(report, null, 2)}\n`);
      },
    ],
    [
      "wrong name",
      /**
       * @param {ReturnType<typeof writeArchive>} inputs
       */
      (inputs) => {
        const report = readJsonObject(inputs.reportPath);
        asRecord(report.archive, "archive").name = "other";
        writeFileSync(inputs.reportPath, `${JSON.stringify(report, null, 2)}\n`);
      },
    ],
    [
      "wrong version",
      /**
       * @param {ReturnType<typeof writeArchive>} inputs
       */
      (inputs) => {
        const report = readJsonObject(inputs.reportPath);
        report.version = "9.9.9-canary.1";
        writeFileSync(inputs.reportPath, `${JSON.stringify(report, null, 2)}\n`);
      },
    ],
  ])("rejects %s before checks and writes no receipt", (_label, mutate) => {
    withFixture(({ inputs }) => {
      mutate(inputs);
      let called = false;
      expect(() =>
        verifyPackedArchive(inputs, packageName, () => {
          called = true;
        })
      ).toThrow(/Packed consumer verification does not match this archive/);
      expect(called).toBe(false);
      expect(existsSync(inputs.receiptPath)).toBe(false);
    });
  });

  it("rejects a missing report before checks and writes no receipt", () => {
    withFixture(({ inputs }) => {
      rmSync(inputs.reportPath);
      let called = false;
      expect(() =>
        verifyPackedArchive(inputs, packageName, () => {
          called = true;
        })
      ).toThrow();
      expect(called).toBe(false);
      expect(existsSync(inputs.receiptPath)).toBe(false);
    });
  });

  it("does not let a replaced archive B validate after checks for A", () => {
    withFixture(({ directory, inputs, bytesB }) => {
      try {
        verifyPackedArchive(inputs, packageName, () => {
          writeArchive(directory, bytesB);
        });
      } catch {
        // Replacement may be rejected before the receipt is written.
      }
      expect(() => validateReceipt(inputs, packageName)).toThrow();
    });
  });

  it("rejects validateReceipt after the shared files are replaced", () => {
    withFixture(({ directory, inputs, bytesB }) => {
      verifyPackedArchive(inputs, packageName, () => undefined);
      writeArchive(directory, bytesB);
      expect(() => validateReceipt(inputs, packageName)).toThrow();
    });
  });

  it("propagates failed checks, writes no receipt, and removes the snapshot", () => {
    withFixture(({ inputs }) => {
      /** @type {string | undefined} */
      let snapshotPath;
      expect(() =>
        verifyPackedArchive(inputs, packageName, (path) => {
          snapshotPath = path;
          expect(existsSync(path)).toBe(true);
          throw new Error("checks failed");
        })
      ).toThrow(/checks failed/);
      expect(existsSync(inputs.receiptPath)).toBe(false);
      expect(snapshotPath).toBeDefined();
      expect(existsSync(snapshotPath)).toBe(false);
    });
  });

  it.each(["fail", "0.2.0-canary.1", "stale-digest"])("rejects a receipt with invalid %s", (kind) => {
    withFixture(({ inputs }) => {
      verifyPackedArchive(inputs, packageName, () => undefined);
      const receipt = readJsonObject(inputs.receiptPath);
      if (kind === "fail") receipt.status = "fail";
      else if (kind === "0.2.0-canary.1") receipt.version = kind;
      else receipt.archiveReportSha256 = "0".repeat(64);
      writeFileSync(inputs.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      expect(() => validateReceipt(inputs, packageName)).toThrow(
        /Packed consumer verification does not match this archive/
      );
    });
  });
});
