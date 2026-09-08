import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";

import { asRecord, asString, readJsonObject } from "./lib/json-object.mjs";

export type PackedInputs = {
  reportPath: string;
  archivePath: string;
  receiptPath: string;
  version: string;
};

export type CapturedArchive = {
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

export function captureArchive(inputs: PackedInputs, packageName: string): CapturedArchive {
  const reportBytes = readFileSync(inputs.reportPath);
  const reportSha256 = sha256Hex(reportBytes);
  // SAFETY: JSON.parse is untyped; asRecord below is the contract.
  const parsed = JSON.parse(reportBytes.toString("utf8")) as unknown;
  const report = asRecord(parsed, "archive report");
  if (report.version !== inputs.version) {
    throw new Error("Packed consumer verification does not match this archive");
  }
  const expected = asRecord(report.archive, "archive");
  if (expected.name !== packageName) {
    throw new Error(`${packageName}: archive changed since verification`);
  }
  const archiveBytes = readFileSync(inputs.archivePath);
  const archiveSha256 = sha256Hex(archiveBytes);
  if (asString(expected.sha256, "sha256") !== archiveSha256 || expected.bytes !== archiveBytes.length) {
    throw new Error(`${packageName}: archive changed since verification`);
  }
  return {
    version: inputs.version,
    reportSha256,
    archiveSha256,
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

export function validateReceipt(inputs: PackedInputs, packageName: string): string {
  const report = readJsonObject(inputs.reportPath);
  const verification = readJsonObject(inputs.receiptPath);
  const expected = asRecord(report.archive, "archive");
  if (
    verification.status !== "pass" ||
    report.version !== inputs.version ||
    verification.version !== inputs.version ||
    verification.archiveReportSha256 !== sha256Hex(readFileSync(inputs.reportPath))
  ) {
    throw new Error("Packed consumer verification does not match this archive");
  }
  if (
    expected.name !== packageName ||
    asString(expected.sha256, "sha256") !== sha256Hex(readFileSync(inputs.archivePath))
  ) {
    throw new Error(`${packageName}: archive changed since verification`);
  }
  return inputs.archivePath;
}
