import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageDirectory = resolve(import.meta.dirname, "..");
const scriptsDirectory = join(packageDirectory, "scripts");
const tsconfigPath = resolve(packageDirectory, "tsconfig.json");
const compilerScript = resolve(packageDirectory, "node_modules/typescript/bin/tsc");

const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
const ignoredDirectoryNames = new Set([".cache", ".turbo", "dist", "generated", "node_modules"]);

function posixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function isDeclarationFile(name: string): boolean {
  return (
    name.endsWith(".d.ts") || name.endsWith(".d.mts") || name.endsWith(".d.cts") || name.endsWith(".d.tsx")
  );
}

function isAuthoredSourceFile(name: string): boolean {
  if (isDeclarationFile(name)) return false;
  return sourceExtensions.some((extension) => name.endsWith(extension));
}

function authoredScripts(directory: string): readonly string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return ignoredDirectoryNames.has(entry.name) ? [] : authoredScripts(path);
    }
    return isAuthoredSourceFile(entry.name) ? [posixPath(path)] : [];
  });
}

function packageRelative(path: string): string {
  return posixPath(relative(packageDirectory, path));
}

describe("script type-check coverage", () => {
  it("includes every authored extractor script in the package TypeScript project", () => {
    const discovered = [...authoredScripts(scriptsDirectory)].sort();
    expect(discovered.length).toBeGreaterThan(0);

    const result = spawnSync(
      process.execPath,
      [compilerScript, "--noEmit", "--incremental", "false", "--listFilesOnly", "-p", tsconfigPath],
      { cwd: packageDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
      const detail = [result.stdout, result.stderr].filter((value) => value.length > 0).join("\n");
      throw new Error(`Package type-check inventory failed.\n${detail}`);
    }

    const listed = new Set(
      result.stdout
        .split("\n")
        .map((line) => posixPath(line.trim()))
        .filter((line) => line.length > 0)
    );
    const omitted = discovered.filter((script) => !listed.has(script)).map(packageRelative);
    expect(omitted).toEqual([]);
  });
});
