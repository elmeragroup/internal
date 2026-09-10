import { Effect } from "effect";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertReceipt,
  packReleaseBundle,
  restoreVerifiedRelease,
  unpackRelease,
  verifyRelease,
} from "../src/bundle.ts";
import { assertStableReleaseFiles } from "../src/files.ts";
import type { ReleaseIntent } from "../src/intent.ts";

const commit = "a".repeat(40);
const intent: ReleaseIntent = { channel: "stable", version: "0.2.0", commit };
const packageName = "@elmeragroup/internal";

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeReceipt(directory: string, recordedPackageName: string): void {
  const archive = join(directory, "package.tgz");
  const bytes = readFileSync(archive);
  const reportPath = join(directory, "archive.json");
  writeFileSync(
    reportPath,
    JSON.stringify({
      version: intent.version,
      archive: {
        name: recordedPackageName,
        archive,
        bytes: bytes.length,
        sha256: sha256Hex(bytes),
      },
    })
  );
  writeFileSync(
    join(directory, "verified.json"),
    JSON.stringify({
      version: intent.version,
      archiveReportSha256: sha256Hex(readFileSync(reportPath)),
      status: "pass",
    })
  );
}

function withRecordedArchive(check: (directory: string) => void, recordedPackageName = packageName): void {
  const directory = mkdtempSync(join(tmpdir(), "elmera-release-record-test-"));
  try {
    mkdirSync(join(directory, "package"));
    writeFileSync(
      join(directory, "package/package.json"),
      JSON.stringify({
        name: recordedPackageName,
        version: intent.version,
        elmeraRelease: { channel: intent.channel, commit: intent.commit },
      })
    );
    execFileSync("tar", ["-czf", join(directory, "package.tgz"), "-C", directory, "package"]);
    writeReceipt(directory, recordedPackageName);
    check(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("recorded archive recovery", () => {
  it("checks release PR contents before merge and again before publication", () => {
    withRecordedArchive((directory) => {
      mkdirSync(join(directory, ".changeset"));
      const packageDirectory = join(directory, "packages/app");
      mkdirSync(packageDirectory, { recursive: true });
      const changelog = join(packageDirectory, "CHANGELOG.md");
      writeFileSync(changelog, "# Package\n\n## 0.2.0\n\nRelease notes\n");
      expect(() => assertStableReleaseFiles("0.1.1", "0.2.0", directory, packageDirectory)).not.toThrow();
      expect(() => assertStableReleaseFiles("0.2.0", "0.2.0", directory, packageDirectory)).toThrow(
        "increase"
      );
      writeFileSync(changelog, "# Package\n\n## 0.1.1\n");
      expect(() => assertStableReleaseFiles("0.1.1", "0.2.0", directory, packageDirectory)).toThrow(
        "changelog"
      );
      writeFileSync(
        join(directory, ".changeset/new-fix.md"),
        '---\n"@elmeragroup/internal": patch\n---\nFix\n'
      );
      expect(() => assertStableReleaseFiles("0.1.1", "0.2.0", directory, packageDirectory)).toThrow(
        "consume all changesets"
      );
    });
  });
  it("validates the exact saved archive after restoring it into a different checkout directory", () => {
    withRecordedArchive((directory) => {
      const original = verifyRelease(directory, intent, packageName);
      const bundle = join(directory, "verified-release.tgz");
      packReleaseBundle(directory, bundle);
      const restored = join(directory, "restored");
      mkdirSync(restored);
      unpackRelease(bundle, restored);
      const recovered = verifyRelease(restored, intent, packageName);
      expect(recovered.integrity).toBe(original.integrity);
      expect(recovered.archive).not.toBe(original.archive);
    });
  });
  it("verifies an archive for a package that is not Internal", () => {
    withRecordedArchive((directory) => {
      expect(verifyRelease(directory, intent, "@acme/app").integrity).toMatch(/^sha512-/);
    }, "@acme/app");
  });
  it("rejects a receipt that no longer matches the archive", () => {
    withRecordedArchive((directory) => {
      expect(assertReceipt(directory, intent, packageName)).toMatch(/package\.tgz$/);
      writeFileSync(
        join(directory, "verified.json"),
        JSON.stringify({
          version: intent.version,
          archiveReportSha256: "0".repeat(64),
          status: "fail",
        })
      );
      expect(() => assertReceipt(directory, intent, packageName)).toThrow("does not match");
    });
  });
  it("rejects tampered bytes and a different source commit", () => {
    withRecordedArchive((directory) => {
      expect(() => verifyRelease(directory, { ...intent, commit: "b".repeat(40) }, packageName)).toThrow(
        "recorded release source"
      );
      appendFileSync(join(directory, "package.tgz"), "different bytes");
      expect(() => verifyRelease(directory, intent, packageName)).toThrow("does not match");
    });
  });
  it("rejects unexpected bundle members before extraction", () => {
    withRecordedArchive((directory) => {
      const bundle = join(directory, "bad.tgz");
      writeFileSync(join(directory, "unexpected.txt"), "unexpected");
      execFileSync("tar", [
        "-czf",
        bundle,
        "-C",
        directory,
        "archive.json",
        "package.tgz",
        "verified.json",
        "unexpected.txt",
      ]);
      expect(() => unpackRelease(bundle, directory)).toThrow("inventory");
    });
  });
  it("restores saved bundle bytes through a scoped temp directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "elmera-release-restore-test-"));
    try {
      mkdirSync(join(directory, "package"));
      writeFileSync(
        join(directory, "package/package.json"),
        JSON.stringify({
          name: packageName,
          version: intent.version,
          elmeraRelease: { channel: intent.channel, commit: intent.commit },
        })
      );
      execFileSync("tar", ["-czf", join(directory, "package.tgz"), "-C", directory, "package"]);
      writeReceipt(directory, packageName);
      const bundle = join(directory, "verified-release.tgz");
      packReleaseBundle(directory, bundle);
      const bytes = new Uint8Array(readFileSync(bundle));
      const recovered = await Effect.runPromise(
        Effect.scoped(restoreVerifiedRelease(intent, bytes, packageName))
      );
      expect(recovered.integrity).toMatch(/^sha512-/);
      expect(recovered.archive).toContain("elmera-release-");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
