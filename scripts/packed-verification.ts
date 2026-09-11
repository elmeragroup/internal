import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";

/**
 * Runs the consumer checks against a private snapshot of the packed archive, then fails if the
 * live archive changed while the checks ran. The recorded release re-verifies the archive's
 * manifest and integrity, so this only guards the local check itself.
 */
export function verifyPackedArchive(
  archivePath: string,
  packageName: string,
  runChecks: (snapshotArchivePath: string) => void
): void {
  const archiveBytes = readFileSync(archivePath);
  const snapshotDirectory = mkdtempSync(resolve(tmpdir(), "elmera-packed-snapshot-"));
  const snapshotArchivePath = resolve(snapshotDirectory, basename(archivePath));
  try {
    writeFileSync(snapshotArchivePath, archiveBytes);
    runChecks(snapshotArchivePath);
    if (!archiveBytes.equals(readFileSync(archivePath))) {
      throw new Error(`${packageName}: archive changed since verification`);
    }
  } finally {
    rmSync(snapshotDirectory, { recursive: true, force: true });
  }
}
