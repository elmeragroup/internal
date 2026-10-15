import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PackAndVerify } from "../../src/archive.ts";
import type { ReleaseIntent } from "../../src/intent.ts";

/**
 * A real gzipped package archive whose packed manifest carries `intent` as its packed identity,
 * the shape a consumer's pack-and-verify adapter returns.
 */
export function packArchive(packageName: string, intent: ReleaseIntent): Uint8Array {
  const directory = mkdtempSync(join(tmpdir(), "elmera-release-pack-"));
  try {
    mkdirSync(join(directory, "package"));
    writeFileSync(
      join(directory, "package/package.json"),
      JSON.stringify({
        name: packageName,
        version: intent.version,
        elmeraRelease: { commit: intent.commit, channel: intent.channel },
      })
    );
    const archive = join(directory, "package.tgz");
    execFileSync("tar", ["-czf", archive, "-C", directory, "package"]);
    return new Uint8Array(readFileSync(archive));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A pack-and-verify adapter and every archive it returned, oldest first. */
export type RecordingPacker = {
  readonly adapter: PackAndVerify;
  readonly packed: readonly Uint8Array[];
};

/** A pack-and-verify adapter that packs real archives and keeps every archive it returned. */
export function recordingPacker(packageName: string): RecordingPacker {
  const packed: Uint8Array[] = [];
  return {
    adapter: {
      pack: (intent) => {
        const bytes = packArchive(packageName, intent);
        packed.push(bytes);
        return bytes;
      },
    },
    packed,
  };
}
