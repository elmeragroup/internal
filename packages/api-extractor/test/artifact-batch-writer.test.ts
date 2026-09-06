import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { writeArtifactBatchOrThrow } from "../scripts/artifact-batch-writer.ts";
import { makeArtifactBatchWriterForTest, writeArtifactBatch } from "../scripts/artifact-batch-writer.ts";

const faultInjectionDeadlineMs = 250;

function transactionEntries(root: string): readonly string[] {
  return readdirSync(root).filter((entry) => entry.startsWith(".artifact-batch-"));
}

describe("artifact batch writer", () => {
  it("writes a complete multi-artifact batch and removes transaction state", async () => {
    const root = mkdtempSync(join(tmpdir(), "api-extractor-artifact-batch-"));
    try {
      writeFileSync(join(root, "existing.json"), "old contents\n");

      const result = await writeArtifactBatch({
        outputRoot: root,
        artifacts: [
          {
            destination: "existing.json",
            content: "new contents\n",
            evidence: "generated",
          },
          {
            destination: "nested/new.json",
            content: '{"status":"pass"}\n',
            evidence: "reviewed",
          },
        ],
      });

      expect(result).toEqual({
        status: "success",
        artifacts: [
          { destination: "existing.json", evidence: "generated" },
          { destination: "nested/new.json", evidence: "reviewed" },
        ],
      });
      expect(readFileSync(join(root, "existing.json"), "utf8")).toBe("new contents\n");
      expect(readFileSync(join(root, "nested/new.json"), "utf8")).toBe('{"status":"pass"}\n');
      expect(transactionEntries(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves every committed output when cleanup deletes one backup before failing", async () => {
    const root = mkdtempSync(join(tmpdir(), "api-extractor-partial-backup-cleanup-"));
    try {
      writeFileSync(join(root, "first.json"), "old first");
      writeFileSync(join(root, "second.json"), "old second");
      let partialCleanup = false;
      const write = makeArtifactBatchWriterForTest({
        runFileSystemOperation: ({ kind, path, run }) => {
          if (kind === "remove" && existsSync(join(path, "backups", "0"))) {
            rmSync(join(path, "backups", "0"));
            partialCleanup = true;
            throw new Error("cleanup failed after deleting the first backup");
          }
          return run();
        },
      });
      const result = await write({
        outputRoot: root,
        artifacts: ["first.json", "second.json", "new.json"].map((destination) => ({
          destination,
          content: `new ${destination}`,
          evidence: "generated" as const,
        })),
      });
      expect(partialCleanup).toBe(true);
      expect(result).toMatchObject({
        status: "success",
        cleanup: {
          temporaryState: "not-removed",
          message: "The artifact batch was committed, but its transaction state could not be removed.",
        },
      });
      for (const name of ["first.json", "second.json", "new.json"]) {
        expect(readFileSync(join(root, name), "utf8")).toBe(`new ${name}`);
      }
      expect(existsSync(join(root, ".artifact-batch-lock"))).toBe(false);
      expect(transactionEntries(root)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports committed output as successful when final lock cleanup fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "api-extractor-artifact-lock-cleanup-"));
    try {
      writeFileSync(join(root, "report.json"), "original report\n");
      const writeWithLockCleanupFailure = makeArtifactBatchWriterForTest({
        runFileSystemOperation: ({ kind, path, run }) => {
          if (kind === "remove" && path.endsWith(".artifact-batch-lock")) {
            throw new Error("synthetic lock cleanup failure");
          }
          return run();
        },
      });

      const result = await writeWithLockCleanupFailure({
        outputRoot: root,
        artifacts: [{ destination: "report.json", content: "replacement report\n", evidence: "generated" }],
      });

      expect(result).toEqual({
        status: "success",
        artifacts: [{ destination: "report.json", evidence: "generated" }],
        cleanup: {
          temporaryState: "not-removed",
          message: "The artifact batch was committed, but its lock could not be removed.",
        },
      });
      expect(readFileSync(join(root, "report.json"), "utf8")).toBe("replacement report\n");
      expect(transactionEntries(root)).toEqual([".artifact-batch-lock"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports uncertain lock cleanup when acquisition times out after mkdir starts", async () => {
    const root = mkdtempSync(join(tmpdir(), "api-extractor-artifact-lock-timeout-"));
    try {
      let lockStalled = false;
      const writeWithUncertainLock = makeArtifactBatchWriterForTest({
        maximumDurationMs: faultInjectionDeadlineMs,
        runFileSystemOperation: ({ kind, path, run }) => {
          if (!lockStalled && kind === "make-directory" && path.endsWith(".artifact-batch-lock")) {
            lockStalled = true;
            return run().then(() => new Promise<never>(() => undefined));
          }
          return run();
        },
      });

      const result = await writeWithUncertainLock({
        outputRoot: root,
        artifacts: [{ destination: "report.json", content: "report\n", evidence: "generated" }],
      });

      expect(result).toEqual({
        status: "failure",
        error: {
          category: "interrupted",
          message: "The artifact batch did not complete within its allowed time.",
          recovery: {
            originalState: "restored",
            temporaryState: "not-removed",
          },
        },
      });
      expect(existsSync(join(root, "report.json"))).toBe(false);
      expect(transactionEntries(root)).toEqual([".artifact-batch-lock"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects the whole batch before changing an earlier valid destination", async () => {
    const root = mkdtempSync(join(tmpdir(), "api-extractor-artifact-preflight-"));
    const outsidePath = join(root, "../escaped-artifact.json");
    try {
      writeFileSync(join(root, "existing.json"), "original\n");

      const result = await writeArtifactBatch({
        outputRoot: root,
        artifacts: [
          {
            destination: "existing.json",
            content: "replacement\n",
            evidence: "generated",
          },
          {
            destination: "../escaped-artifact.json",
            content: "escaped\n",
            evidence: "generated",
          },
        ],
      });

      expect(result).toEqual({
        status: "failure",
        error: {
          category: "invalid-destination",
          message: "Artifact destination escapes the output root.",
          destination: "../escaped-artifact.json",
        },
      });
      expect(readFileSync(join(root, "existing.json"), "utf8")).toBe("original\n");
      expect(existsSync(outsidePath)).toBe(false);
      expect(transactionEntries(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outsidePath, { force: true });
    }
  });

  /**
   * Rollback is covered twice on purpose.
   *
   * The control-driven case below runs everywhere, including as root in a CI
   * container, so the rollback contract is never left untested. The
   * real-permission case can only run where permission bits decide anything;
   * under root it asserts that it is not applicable instead of vanishing from
   * the report.
   */
  const rootUser = process.getuid?.() === 0;

  it("restores every original destination when a later artifact cannot be written", async () => {
    const root = mkdtempSync(join(tmpdir(), "api-extractor-artifact-rollback-"));
    try {
      writeFileSync(join(root, "first.json"), "first original\n");
      writeFileSync(join(root, "second.json"), "second original\n");
      const writeWithFailure = makeArtifactBatchWriterForTest({
        beforeArtifactWrite: ({ index }) => {
          if (index === 1) throw new Error("synthetic artifact write failure");
        },
      });

      const result = await writeWithFailure({
        outputRoot: root,
        artifacts: [
          { destination: "first.json", content: "first replacement\n", evidence: "generated" },
          { destination: "second.json", content: "second replacement\n", evidence: "reviewed" },
        ],
      });

      // A failure raised at one artifact names that artifact.
      expect(result).toEqual({
        status: "failure",
        error: {
          category: "write-failed",
          message: "synthetic artifact write failure",
          destination: "second.json",
          recovery: { originalState: "restored", temporaryState: "removed" },
        },
      });
      expect(readFileSync(join(root, "first.json"), "utf8")).toBe("first original\n");
      expect(readFileSync(join(root, "second.json"), "utf8")).toBe("second original\n");
      expect(transactionEntries(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores every original destination when a read-only file rejects a later write", async () => {
    if (rootUser) {
      // Not applicable: root writes through a read-only file, so this
      // environment cannot produce the refusal under test. The
      // control-driven case above still covers rollback here.
      expect(process.getuid?.()).toBe(0);
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "api-extractor-artifact-rollback-"));
    const readOnlyDirectory = join(root, "sealed");
    try {
      writeFileSync(join(root, "first.json"), "first original\n");
      mkdirSync(readOnlyDirectory);
      writeFileSync(join(readOnlyDirectory, "second.json"), "second original\n");
      // A read-only file in a read-only directory is the real failure the
      // rollback path exists for: the batch commits its first artifact, the
      // operating system refuses the second, and both originals come back.
      chmodSync(join(readOnlyDirectory, "second.json"), 0o444);
      chmodSync(readOnlyDirectory, 0o555);

      const result = await writeArtifactBatch({
        outputRoot: root,
        artifacts: [
          { destination: "first.json", content: "first replacement\n", evidence: "generated" },
          { destination: "sealed/second.json", content: "second replacement\n", evidence: "reviewed" },
        ],
      });

      // The refusal happens while the transaction stages and swaps files
      // rather than at one artifact's own write, so the writer reports the
      // batch-level message with no `destination`. The control-driven case
      // above pins the per-artifact shape; this one pins the real one.
      expect(result).toEqual({
        status: "failure",
        error: {
          category: "write-failed",
          message: "The artifact batch could not be fully written.",
          recovery: { originalState: "restored", temporaryState: "removed" },
        },
      });
      expect(readFileSync(join(root, "first.json"), "utf8")).toBe("first original\n");
      expect(readFileSync(join(readOnlyDirectory, "second.json"), "utf8")).toBe("second original\n");
      expect(transactionEntries(root)).toEqual([]);
    } finally {
      chmodSync(readOnlyDirectory, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate and file-directory destinations before staging", async () => {
    const root = mkdtempSync(join(tmpdir(), "api-extractor-artifact-conflict-"));
    try {
      const duplicate = await writeArtifactBatch({
        outputRoot: root,
        artifacts: [
          { destination: "nested/../same.json", content: "first\n", evidence: "generated" },
          { destination: "same.json", content: "second\n", evidence: "reviewed" },
        ],
      });
      expect(duplicate.status).toBe("failure");
      if (duplicate.status === "failure") {
        expect(duplicate.error.category).toBe("duplicate-destination");
      }

      const fileDirectoryConflict = await writeArtifactBatch({
        outputRoot: root,
        artifacts: [
          { destination: "evidence", content: "file\n", evidence: "generated" },
          { destination: "evidence/report.json", content: "nested\n", evidence: "generated" },
        ],
      });
      expect(fileDirectoryConflict.status).toBe("failure");
      if (fileDirectoryConflict.status === "failure") {
        expect(fileDirectoryConflict.error.category).toBe("file-directory-conflict");
      }

      expect(existsSync(join(root, "same.json"))).toBe(false);
      expect(existsSync(join(root, "evidence"))).toBe(false);
      expect(transactionEntries(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects immutable evidence and symlink escapes without changing the destination tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "api-extractor-artifact-policy-"));
    const outside = mkdtempSync(join(tmpdir(), "api-extractor-artifact-outside-"));
    try {
      mkdirSync(join(root, "fixture"));
      writeFileSync(join(root, "fixture/output.json"), "upstream oracle\n");
      symlinkSync(outside, join(root, "linked"), "dir");

      const immutable = await writeArtifactBatch({
        outputRoot: root,
        artifacts: [
          {
            destination: "fixture/generated.json",
            content: "ordinary generated output\n",
            evidence: "generated",
          },
          {
            destination: "fixture/warnings.json",
            content: "reviewed warning evidence\n",
            evidence: "reviewed",
          },
          {
            destination: "fixture/output.json",
            content: "replacement\n",
            evidence: "immutable-upstream",
          },
        ],
      });
      expect(immutable.status).toBe("failure");
      if (immutable.status === "failure") expect(immutable.error.category).toBe("immutable-oracle");

      const symlinkEscape = await writeArtifactBatch({
        outputRoot: root,
        artifacts: [{ destination: "linked/escaped.json", content: "escaped\n", evidence: "generated" }],
      });
      expect(symlinkEscape.status).toBe("failure");
      if (symlinkEscape.status === "failure") {
        expect(symlinkEscape.error.category).toBe("symlink-escape");
      }

      expect(readFileSync(join(root, "fixture/output.json"), "utf8")).toBe("upstream oracle\n");
      expect(existsSync(join(root, "fixture/generated.json"))).toBe(false);
      expect(existsSync(join(root, "fixture/warnings.json"))).toBe(false);
      expect(existsSync(join(outside, "escaped.json"))).toBe(false);
      expect(transactionEntries(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("preserves writer failure details when a command requires throwing", async () => {
    const root = mkdtempSync(join(tmpdir(), "api-extractor-artifact-command-error-"));
    try {
      await expect(
        writeArtifactBatchOrThrow(
          {
            outputRoot: root,
            artifacts: [
              {
                destination: "fixture/output.json",
                content: "replacement\n",
                evidence: "immutable-upstream",
              },
            ],
          },
          "Test evidence write"
        )
      ).rejects.toMatchObject({
        name: "ArtifactBatchCommandError",
        category: "immutable-oracle",
        destination: "fixture/output.json",
        message:
          "Test evidence write failed for fixture/output.json (immutable-oracle): Immutable upstream evidence cannot be written by the artifact batch writer.",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores mixed evidence after a recoverable rollback fault and cleanup retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "api-extractor-artifact-recovery-"));
    try {
      writeFileSync(join(root, "generated.json"), "generated original\n");
      writeFileSync(join(root, "warnings.json"), "warnings original\n");
      let rollbackAttempts = 0;
      let transactionCleanupAttempts = 0;
      const writeWithRecovery = makeArtifactBatchWriterForTest({
        beforeArtifactWrite: ({ index }) => {
          if (index === 1) throw new Error("synthetic reviewed evidence failure");
        },
        beforeRollbackRestore: ({ destination }) => {
          if (destination === "warnings.json" && rollbackAttempts++ === 0) {
            throw new Error("synthetic recoverable rollback failure");
          }
        },
        beforeTemporaryCleanup: ({ kind }) => {
          if (kind === "transaction" && transactionCleanupAttempts++ === 0) {
            throw new Error("synthetic recoverable cleanup failure");
          }
        },
      });

      const result = await writeWithRecovery({
        outputRoot: root,
        artifacts: [
          { destination: "generated.json", content: "generated replacement\n", evidence: "generated" },
          { destination: "warnings.json", content: "warnings replacement\n", evidence: "reviewed" },
        ],
      });

      expect(result).toEqual({
        status: "failure",
        error: {
          category: "write-failed",
          message: "synthetic reviewed evidence failure",
          destination: "warnings.json",
          recovery: {
            originalState: "restored-after-retry",
            temporaryState: "removed-after-retry",
          },
        },
      });
      expect(readFileSync(join(root, "generated.json"), "utf8")).toBe("generated original\n");
      expect(readFileSync(join(root, "warnings.json"), "utf8")).toBe("warnings original\n");
      expect(transactionEntries(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an overlapping writer without allowing a mixed artifact set", async () => {
    const root = mkdtempSync(join(tmpdir(), "api-extractor-artifact-concurrent-"));
    try {
      writeFileSync(join(root, "first.json"), "original first\n");
      writeFileSync(join(root, "second.json"), "original second\n");
      let releaseFirst!: () => void;
      const firstPaused = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let announcePause!: () => void;
      const paused = new Promise<void>((resolve) => {
        announcePause = resolve;
      });
      const firstWriter = makeArtifactBatchWriterForTest({
        beforeArtifactWrite: async ({ index }) => {
          if (index !== 0) return;
          announcePause();
          await firstPaused;
        },
      });

      const first = firstWriter({
        outputRoot: root,
        artifacts: [
          { destination: "first.json", content: "winner first\n", evidence: "generated" },
          { destination: "second.json", content: "winner second\n", evidence: "reviewed" },
        ],
      });
      await paused;
      const second = await writeArtifactBatch({
        outputRoot: root,
        artifacts: [
          { destination: "first.json", content: "loser first\n", evidence: "generated" },
          { destination: "second.json", content: "loser second\n", evidence: "reviewed" },
        ],
      });
      releaseFirst();

      expect(second).toEqual({
        status: "failure",
        error: {
          category: "concurrent-write",
          message: "Another artifact batch is already writing to this output root.",
        },
      });
      await expect(first).resolves.toMatchObject({ status: "success" });
      expect(readFileSync(join(root, "first.json"), "utf8")).toBe("winner first\n");
      expect(readFileSync(join(root, "second.json"), "utf8")).toBe("winner second\n");
      expect(transactionEntries(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns an interrupted failure within a bounded time and restores the destination", async () => {
    const root = mkdtempSync(join(tmpdir(), "api-extractor-artifact-timeout-"));
    try {
      writeFileSync(join(root, "report.json"), "original report\n");
      const writeThatStalls = makeArtifactBatchWriterForTest({
        maximumDurationMs: faultInjectionDeadlineMs,
        beforeArtifactWrite: () => new Promise<void>(() => undefined),
      });
      const startedAt = Date.now();

      const result = await writeThatStalls({
        outputRoot: root,
        artifacts: [{ destination: "report.json", content: "replacement\n", evidence: "reviewed" }],
      });

      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(result).toEqual({
        status: "failure",
        error: {
          category: "interrupted",
          message: "The artifact batch did not complete within its allowed time.",
          destination: "report.json",
          recovery: {
            originalState: "restored",
            temporaryState: "removed",
          },
        },
      });
      expect(readFileSync(join(root, "report.json"), "utf8")).toBe("original report\n");
      expect(transactionEntries(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds a stalled filesystem operation and restores the destination", async () => {
    const root = mkdtempSync(join(tmpdir(), "api-extractor-artifact-filesystem-timeout-"));
    try {
      writeFileSync(join(root, "report.json"), "original report\n");
      let renameStalled = false;
      const writeWithStalledRename = makeArtifactBatchWriterForTest({
        maximumDurationMs: faultInjectionDeadlineMs,
        runFileSystemOperation: ({ kind, path, run }) => {
          if (!renameStalled && kind === "rename" && path.endsWith("report.json")) {
            renameStalled = true;
            return new Promise<never>(() => undefined);
          }
          return run();
        },
      });
      const startedAt = Date.now();

      const result = await writeWithStalledRename({
        outputRoot: root,
        artifacts: [{ destination: "report.json", content: "replacement\n", evidence: "reviewed" }],
      });

      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(result).toEqual({
        status: "failure",
        error: {
          category: "interrupted",
          message: "The artifact batch did not complete within its allowed time.",
          destination: "report.json",
          recovery: {
            originalState: "restored",
            temporaryState: "removed",
          },
        },
      });
      expect(readFileSync(join(root, "report.json"), "utf8")).toBe("original report\n");
      expect(transactionEntries(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps recovery independent from a short primary-operation deadline", async () => {
    const root = mkdtempSync(join(tmpdir(), "api-extractor-artifact-recovery-deadline-"));
    try {
      writeFileSync(join(root, "report.json"), "original report\n");
      let renameStalled = false;
      const writeWithStalledRename = makeArtifactBatchWriterForTest({
        maximumDurationMs: faultInjectionDeadlineMs,
        beforeTemporaryCleanup: ({ kind }) =>
          kind === "transaction"
            ? new Promise<void>((resolve) => {
                setTimeout(resolve, faultInjectionDeadlineMs / 2);
              })
            : undefined,
        runFileSystemOperation: ({ kind, path, run }) => {
          if (!renameStalled && kind === "rename" && path.endsWith("report.json")) {
            renameStalled = true;
            return new Promise<never>(() => undefined);
          }
          return run();
        },
      });

      const result = await writeWithStalledRename({
        outputRoot: root,
        artifacts: [{ destination: "report.json", content: "replacement\n", evidence: "reviewed" }],
      });

      expect(result).toEqual({
        status: "failure",
        error: {
          category: "interrupted",
          message: "The artifact batch did not complete within its allowed time.",
          destination: "report.json",
          recovery: {
            originalState: "restored",
            temporaryState: "removed",
          },
        },
      });
      expect(readFileSync(join(root, "report.json"), "utf8")).toBe("original report\n");
      expect(transactionEntries(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not claim restoration when a timed-out mutation may still complete", async () => {
    const root = mkdtempSync(join(tmpdir(), "api-extractor-artifact-uncertain-timeout-"));
    try {
      writeFileSync(join(root, "report.json"), "original report\n");
      let renameStalled = false;
      const writeWithUncertainRename = makeArtifactBatchWriterForTest({
        maximumDurationMs: faultInjectionDeadlineMs,
        runFileSystemOperation: ({ kind, path, run }) => {
          if (!renameStalled && kind === "rename" && path.endsWith("report.json")) {
            renameStalled = true;
            void run();
            return new Promise<never>(() => undefined);
          }
          return run();
        },
      });

      const result = await writeWithUncertainRename({
        outputRoot: root,
        artifacts: [{ destination: "report.json", content: "replacement\n", evidence: "reviewed" }],
      });

      expect(result).toEqual({
        status: "failure",
        error: {
          category: "interrupted",
          message: "The artifact batch did not complete within its allowed time.",
          destination: "report.json",
          recovery: {
            originalState: "not-restored",
            temporaryState: "not-removed",
          },
        },
      });
      expect(transactionEntries(root)).toHaveLength(2);
      expect(transactionEntries(root)).toContain(".artifact-batch-lock");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not retry a timed-out rollback mutation or release its recovery lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "api-extractor-artifact-rollback-timeout-"));
    try {
      writeFileSync(join(root, "first.json"), "first original\n");
      writeFileSync(join(root, "second.json"), "second original\n");
      let rollbackRemoveStalled = false;
      const writeWithUncertainRollback = makeArtifactBatchWriterForTest({
        maximumRecoveryDurationMs: 50,
        beforeArtifactWrite: ({ index }) => {
          if (index === 1) throw new Error("synthetic second write failure");
        },
        runFileSystemOperation: ({ kind, path, run }) => {
          if (!rollbackRemoveStalled && kind === "remove" && path.endsWith("first.json")) {
            rollbackRemoveStalled = true;
            return run().then(() => new Promise<never>(() => undefined));
          }
          return run();
        },
      });

      const result = await writeWithUncertainRollback({
        outputRoot: root,
        artifacts: [
          { destination: "first.json", content: "first replacement\n", evidence: "generated" },
          { destination: "second.json", content: "second replacement\n", evidence: "reviewed" },
        ],
      });

      expect(result).toEqual({
        status: "failure",
        error: {
          category: "interrupted",
          message: "The artifact batch did not complete within its allowed time.",
          destination: "first.json",
          recovery: {
            originalState: "not-restored",
            temporaryState: "not-removed",
          },
        },
      });
      expect(transactionEntries(root)).toHaveLength(2);
      expect(transactionEntries(root)).toContain(".artifact-batch-lock");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
