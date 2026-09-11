import { Effect, Schema } from "effect";
import type { Scope } from "effect";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { lift } from "./errors.ts";
import type { ReleaseError } from "./errors.ts";
import type { ReleaseIntent, VerifiedRelease } from "./intent.ts";
import { releaseArchiveName } from "./intent.ts";
import { decodeJson } from "./json.ts";

const PackedManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  elmeraRelease: Schema.Struct({
    commit: Schema.String,
    channel: Schema.Literals(["canary", "stable"] as const),
  }),
});

/** Temporary directory removed when the surrounding Effect scope closes. Process kill is not covered. */
function scratchDirectory(): Effect.Effect<string, ReleaseError, Scope.Scope> {
  return Effect.acquireRelease(
    lift("archive", () => mkdtempSync(resolve(tmpdir(), "elmera-release-"))),
    (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
  );
}

/**
 * Materializes the archive bytes in a scoped temp directory and proves they carry exactly the
 * recorded source. Every durable archive, freshly packed or restored, is verified through here.
 */
export function verifyReleaseArchive(
  intent: ReleaseIntent,
  bytes: Uint8Array,
  packageName: string
): Effect.Effect<VerifiedRelease, ReleaseError, Scope.Scope> {
  return Effect.gen(function* () {
    const directory = yield* scratchDirectory();
    return yield* lift("archive", () => {
      const archive = resolve(directory, releaseArchiveName);
      writeFileSync(archive, bytes);
      const manifest = decodeJson(
        execFileSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" }),
        PackedManifest,
        "packed manifest"
      );
      const source = manifest.elmeraRelease;
      if (
        manifest.name !== packageName ||
        manifest.version !== intent.version ||
        source.commit !== intent.commit ||
        source.channel !== intent.channel
      ) {
        throw new Error("Archive does not match the recorded release source");
      }
      return {
        ...intent,
        archive,
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      };
    });
  });
}
