import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { ProjectFileSystem, ProjectFileSystemEntries } from "../src/options.ts";

const packageDirectory = resolve(import.meta.dirname, "..");
export const moduleImportsOnlyDependency = resolve(packageDirectory, "src/models/export.ts");
const moduleImportsOnlyDependencySource = "export class ExportNode {}\n";

export type FixtureFileSystemAccess = {
  readonly operation: "readFile" | "fileExists" | "directoryExists" | "getAccessibleEntries";
  readonly path: string;
  readonly virtual: boolean;
};

function absolute(path: string): string {
  return resolve(path);
}

function record(
  observer: ((access: FixtureFileSystemAccess) => void) | undefined,
  operation: FixtureFileSystemAccess["operation"],
  path: string,
  virtual: boolean
): void {
  observer?.({ operation, path, virtual });
}

/**
 * Complete test-only filesystem used by the conformance project. Physical
 * reads remain available, while the unchanged upstream import in
 * module-imports-only is supplied entirely through ProjectFileSystem.
 */
export function createFixtureFileSystem(
  observer?: (access: FixtureFileSystemAccess) => void
): ProjectFileSystem {
  const virtualDirectory = dirname(moduleImportsOnlyDependency);
  const virtualFiles = new Map([[moduleImportsOnlyDependency, moduleImportsOnlyDependencySource]]);
  return {
    directoryExists: (directoryName) => {
      const path = absolute(directoryName);
      const virtual = path === virtualDirectory || path === dirname(virtualDirectory);
      record(observer, "directoryExists", path, virtual);
      return virtual || existsSync(path);
    },
    fileExists: (fileName) => {
      const path = absolute(fileName);
      const virtual = virtualFiles.has(path);
      record(observer, "fileExists", path, virtual);
      return virtual || existsSync(path);
    },
    getAccessibleEntries: (directoryName): ProjectFileSystemEntries | undefined => {
      const path = absolute(directoryName);
      if (path === virtualDirectory) {
        record(observer, "getAccessibleEntries", path, true);
        return { files: ["export.ts"], directories: [] };
      }
      if (!existsSync(path)) {
        record(observer, "getAccessibleEntries", path, false);
        return undefined;
      }
      record(observer, "getAccessibleEntries", path, false);
      const entries = readdirSync(path, { withFileTypes: true });
      return {
        files: entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
        directories: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      };
    },
    readFile: (fileName) => {
      const path = absolute(fileName);
      const virtualContent = virtualFiles.get(path);
      record(observer, "readFile", path, virtualContent !== undefined);
      return virtualContent ?? (existsSync(path) ? readFileSync(path, "utf8") : null);
    },
    realpath: (path) => {
      const absolutePath = absolute(path);
      return virtualFiles.has(absolutePath) || absolutePath === virtualDirectory
        ? absolutePath
        : existsSync(absolutePath)
          ? realpathSync(absolutePath)
          : undefined;
    },
  };
}
