import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** `test/fixtures`; every test support module and test derives fixture paths from this one root. */
export const fixtureRoot = resolve(import.meta.dirname, "../fixtures");
const packageRoot = resolve(fixtureRoot, "../..");
const ignoredTemporaryDirectory = resolve(packageRoot, "node_modules/.cache");
export const canonicalTemporaryDirectory = realpathSync(tmpdir());

export function createTemporaryRoot(prefix: string): string {
  return mkdtempSync(join(canonicalTemporaryDirectory, prefix));
}

/** Keep generated fixture copies under the package-local lint-ignored dependency cache. */
export function createIgnoredTemporaryRoot(prefix: string): string {
  mkdirSync(ignoredTemporaryDirectory, { recursive: true });
  return mkdtempSync(join(ignoredTemporaryDirectory, prefix));
}

export function temporaryFilesRecursively(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return temporaryFilesRecursively(path);
    return entry.name.endsWith(".tmp") ? [path] : [];
  });
}

export function stagingDirectoriesFor(root: string): readonly string[] {
  const prefix = `.${basename(root)}.generated-artifact-staging.`;
  const parents = new Set<string>();
  for (const candidate of [dirname(root), canonicalTemporaryDirectory, "/tmp", "/var/tmp"]) {
    try {
      parents.add(realpathSync(candidate));
    } catch {
      // A platform-specific temporary candidate may not exist.
    }
  }
  return [...parents].flatMap((parent) => {
    if (!existsSync(parent)) return [];
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => join(parent, entry.name));
  });
}
