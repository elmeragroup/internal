import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";

import { assertArchiveMatches } from "../packages/release/src/index.ts";

export type PackedInputs = {
  reportPath: string;
  archivePath: string;
  receiptPath: string;
  version: string;
};

type CapturedArchive = {
  version: string;
  reportSha256: string;
  archiveSha256: string;
  archiveBytes: Buffer;
};

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writePassReceipt(receiptPath: string, version: string, archiveReportSha256: string): void {
  writeFileSync(
    receiptPath,
    `${JSON.stringify(
      {
        version,
        archiveReportSha256,
        status: "pass",
      },
      null,
      2
    )}\n`
  );
}

function captureArchive(inputs: PackedInputs, packageName: string): CapturedArchive {
  const reportBytes = readFileSync(inputs.reportPath);
  const archiveBytes = readFileSync(inputs.archivePath);
  const reportSha256 = assertArchiveMatches(reportBytes, archiveBytes, inputs.version, packageName);
  return {
    version: inputs.version,
    reportSha256,
    archiveSha256: sha256Hex(archiveBytes),
    archiveBytes,
  };
}

export function verifyPackedArchive(
  inputs: PackedInputs,
  packageName: string,
  runChecks: (snapshotArchivePath: string) => void
): void {
  rmSync(inputs.receiptPath, { force: true });
  const captured = captureArchive(inputs, packageName);
  const snapshotDirectory = mkdtempSync(resolve(tmpdir(), "elmera-packed-snapshot-"));
  const snapshotArchivePath = resolve(snapshotDirectory, basename(inputs.archivePath));
  try {
    writeFileSync(snapshotArchivePath, captured.archiveBytes);
    runChecks(snapshotArchivePath);
    // Fail if the live archive or report changed during runChecks. This message is
    // reserved for post-verification drift; captureArchive uses a different error.
    if (
      sha256Hex(readFileSync(inputs.reportPath)) !== captured.reportSha256 ||
      sha256Hex(readFileSync(inputs.archivePath)) !== captured.archiveSha256
    ) {
      throw new Error(`${packageName}: archive changed since verification`);
    }
    writePassReceipt(inputs.receiptPath, captured.version, captured.reportSha256);
  } finally {
    rmSync(snapshotDirectory, { recursive: true, force: true });
  }
}
