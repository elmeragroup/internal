import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** `test/fixtures`; every test support module and test derives fixture paths from this one root. */
export const fixtureRoot = resolve(import.meta.dirname, "../fixtures");
const canonicalTemporaryDirectory = realpathSync(tmpdir());

export function createTemporaryRoot(prefix: string): string {
  return mkdtempSync(join(canonicalTemporaryDirectory, prefix));
}
