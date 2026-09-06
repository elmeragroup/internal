import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import {
  makeArtifactBatchWriterForTest,
  writeArtifactBatchOrThrow,
} from "../scripts/artifact-batch-writer.ts";

it("reports committed timing artifacts as completed when transaction cleanup partially fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "api-extractor-command-cleanup-"));
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    writeFileSync(join(root, "timing-boundary.json"), "old timing report");
    const writer = makeArtifactBatchWriterForTest({
      runFileSystemOperation: ({ kind, path, run }) => {
        const backup = join(path, "backups", "0");
        if (kind === "remove" && existsSync(backup)) {
          rmSync(backup);
          throw new Error("partial backup cleanup");
        }
        return run();
      },
    });
    const result = await writeArtifactBatchOrThrow(
      {
        outputRoot: root,
        artifacts: [
          { destination: "timing-boundary.json", content: "new timing report", evidence: "generated" },
        ],
      },
      "Issue 02 timing artifact write",
      writer
    );
    expect(result.status).toBe("success");
    expect(readFileSync(join(root, "timing-boundary.json"), "utf8")).toBe("new timing report");
    expect(stderr).toHaveBeenCalledWith(
      "Issue 02 timing artifact write completed. The artifact batch was committed, but its transaction state could not be removed.\n"
    );
  } finally {
    stderr.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
