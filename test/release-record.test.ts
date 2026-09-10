import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { verifyPackedArchive } from "../scripts/packed-verification.ts";
import { assertStableReleaseFiles } from "../scripts/release-files.ts";
import {
  packReleaseBundle,
  parseIntent,
  releaseTag,
  unpackRelease,
  verifyRelease,
} from "../scripts/release-record.ts";
import type { ReleaseIntent } from "../scripts/release-record.ts";
import { packageName } from "../scripts/release.ts";

const commit = "a".repeat(40);
const intent: ReleaseIntent = { channel: "stable", version: "0.2.0", commit };

function withRecordedArchive(check: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "elmera-release-record-test-"));
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
    const archive = join(directory, "package.tgz");
    execFileSync("tar", ["-czf", archive, "-C", directory, "package"]);
    const bytes = readFileSync(archive);
    const inputs = {
      reportPath: join(directory, "archive.json"),
      receiptPath: join(directory, "verified.json"),
      archivePath: archive,
      version: intent.version,
    };
    writeFileSync(
      inputs.reportPath,
      JSON.stringify({
        version: intent.version,
        archive: {
          name: packageName,
          archive,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      })
    );
    verifyPackedArchive(inputs, packageName, (snapshot) => {
      expect(
        execFileSync("tar", ["-xOzf", snapshot, "package/package.json"], { encoding: "utf8" })
      ).toContain(intent.commit);
    });
    check(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("release identity", () => {
  it("validates record schema, channel, version and full source SHA", () => {
    const recorded = { schema: 1, channel: "stable", version: "0.2.0", commit };
    expect(releaseTag(parseIntent(JSON.stringify(recorded)))).toBe("v0.2.0");
    for (const invalid of [
      { ...recorded, channel: "beta" },
      { ...recorded, version: "0.2.0-canary.0" },
      { ...recorded, commit: "main" },
    ]) {
      expect(() => parseIntent(JSON.stringify(invalid))).toThrow();
    }
  });
});

describe("recorded archive recovery", () => {
  it("checks release PR contents before merge and again before publication", () => {
    withRecordedArchive((directory) => {
      mkdirSync(join(directory, ".changeset"));
      mkdirSync(join(directory, "packages/internal"), { recursive: true });
      const changelog = join(directory, "packages/internal/CHANGELOG.md");
      writeFileSync(changelog, "# Package\n\n## 0.2.0\n\nRelease notes\n");
      expect(() => assertStableReleaseFiles("0.1.1", "0.2.0", directory)).not.toThrow();
      expect(() => assertStableReleaseFiles("0.2.0", "0.2.0", directory)).toThrow("increase");
      writeFileSync(changelog, "# Package\n\n## 0.1.1\n");
      expect(() => assertStableReleaseFiles("0.1.1", "0.2.0", directory)).toThrow("changelog");
      writeFileSync(
        join(directory, ".changeset/new-fix.md"),
        '---\n"@elmeragroup/internal": patch\n---\nFix\n'
      );
      expect(() => assertStableReleaseFiles("0.1.1", "0.2.0", directory)).toThrow("consume all changesets");
    });
  });
  it("validates the exact saved archive after restoring it into a different checkout directory", () => {
    withRecordedArchive((directory) => {
      const original = verifyRelease(directory, intent);
      const bundle = join(directory, "verified-release.tgz");
      packReleaseBundle(directory, bundle);
      const restored = join(directory, "restored");
      mkdirSync(restored);
      unpackRelease(bundle, restored);
      const recovered = verifyRelease(restored, intent);
      expect(recovered.integrity).toBe(original.integrity);
      expect(recovered.archive).not.toBe(original.archive);
    });
  });
  it("rejects tampered bytes and a different source commit", () => {
    withRecordedArchive((directory) => {
      expect(() => verifyRelease(directory, { ...intent, commit: "b".repeat(40) })).toThrow(
        "recorded release source"
      );
      appendFileSync(join(directory, "package.tgz"), "different bytes");
      expect(() => verifyRelease(directory, intent)).toThrow("does not match");
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
});
