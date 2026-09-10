import { Effect } from "effect";
import type { Scope } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { toReleaseError } from "./errors.ts";
import type { ReleaseError } from "./errors.ts";

/** Temporary directory removed when the surrounding Effect scope closes. Process kill is not covered. */
export function scratchDirectory(prefix: string): Effect.Effect<string, ReleaseError, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.try({
      try: () => mkdtempSync(resolve(tmpdir(), prefix)),
      catch: toReleaseError,
    }),
    (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
  );
}
