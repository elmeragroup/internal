import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

export type PathIdentity = {
  readonly platform: string;
  readonly provenanceRoot: string;
  readonly sameSourceFile: (left: string, right: string) => boolean;
  readonly compilerSourceFileName: (path: string, isRegistered: (candidate: string) => boolean) => string;
};

export function createPathIdentity(options: {
  readonly platform: string;
  readonly provenanceRoot: string;
  readonly nativeRealpath?: (path: string) => string | undefined;
  readonly virtualRealpath?: (path: string) => string | undefined;
}): PathIdentity {
  const nativeRealpath = options.nativeRealpath ?? hostNativeRealpath;
  return {
    platform: options.platform,
    provenanceRoot: options.provenanceRoot,
    sameSourceFile: (left, right) => sameSourceFile(left, right, options.platform),
    compilerSourceFileName: (path, isRegistered) =>
      compilerSourceFileName(path, {
        platform: options.platform,
        rootedPath: registeredRootSpelling(path, options.provenanceRoot, options.platform),
        nativePath: nativeRealpath(path),
        virtualPath: options.virtualRealpath?.(path),
        isRegistered,
      }),
  };
}

/**
 * Compiler path identity: keep the original for case-only and Darwin
 * root-prefix corrections; switch only when the original is unregistered and
 * the candidate is.
 */
export function compilerSourceFileName(
  path: string,
  candidates: {
    readonly platform: string;
    readonly rootedPath?: string;
    readonly nativePath?: string;
    readonly virtualPath?: string;
    readonly isRegistered: (candidate: string) => boolean;
  }
): string {
  const nativeSpelling =
    candidates.nativePath !== undefined && sameSourceFile(path, candidates.nativePath, candidates.platform)
      ? candidates.nativePath
      : undefined;
  const compilerSpelling = nativeSpelling ?? candidates.rootedPath ?? path;
  if (candidates.virtualPath !== undefined && candidates.virtualPath !== path) {
    if (candidates.isRegistered(path)) return compilerSpelling;
    if (candidates.isRegistered(candidates.virtualPath)) return candidates.virtualPath;
  }
  if (nativeSpelling !== undefined || candidates.rootedPath !== undefined || candidates.nativePath === path) {
    return compilerSpelling;
  }
  if (candidates.nativePath !== undefined && candidates.nativePath !== path) {
    if (candidates.isRegistered(path)) return path;
    if (candidates.isRegistered(candidates.nativePath)) return candidates.nativePath;
  }
  return path;
}

/**
 * Restores the opened root's casing without resolving a symlinked suffix.
 * The compiler supplied `path`; on Darwin, changing only its root-prefix
 * casing cannot select another file on the case-insensitive native volume.
 */
export function registeredRootSpelling(
  path: string,
  provenanceRoot: string,
  platform: string
): string | undefined {
  if (platform !== "darwin") return undefined;
  const rootPrefix = provenanceRoot.endsWith("/") ? provenanceRoot : `${provenanceRoot}/`;
  if (path.startsWith(rootPrefix) || !path.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
    return undefined;
  }
  return `${rootPrefix}${path.slice(rootPrefix.length)}`;
}

function hostNativeRealpath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

/**
 * Whether two compiler/authored path spellings name the same source file.
 * Darwin compiler Path values are lower-cased while authored resolve() spelling
 * is kept; folding on a case-sensitive volume would treat Foo.ts and foo.ts as
 * the same module.
 */
export function sameSourceFile(left: string, right: string, platform: string): boolean {
  if (left === right) return true;
  const normalizedLeft = left.replaceAll("\\", "/");
  const normalizedRight = right.replaceAll("\\", "/");
  if (normalizedLeft === normalizedRight) return true;
  if (platform !== "darwin") return false;
  return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
}

/**
 * Repository-relative form of an absolute file path, with forward slashes.
 *
 * Single owner for every repository-relative path the backend reports —
 * provenance declaration paths, re-export chains, and derived module names.
 * An empty relative result (the file equal to the root itself, which no real
 * module file reaches) normalizes to `.`, exactly as the provenance side has
 * always reported; the module walk previously returned the empty string
 * there, so no reachable input observes the reconciliation.
 */
export function repositoryRelativePath(rootDirectory: string, filePath: string): string {
  const normalizedRootWithTrailingSlash = rootDirectory.replaceAll("\\", "/");
  const normalizedRoot =
    normalizedRootWithTrailingSlash === "/" ? "/" : normalizedRootWithTrailingSlash.replace(/\/+$/u, "");
  const normalizedFile = filePath.replaceAll("\\", "/");
  const rootPrefix = normalizedRoot === "/" ? "/" : `${normalizedRoot}/`;
  // A leading double slash is also a valid POSIX/VFS spelling. Only a drive
  // root or authored backslash UNC root opts into Windows case semantics.
  const windowsPath = /^[A-Za-z]:[\\/]/u.test(rootDirectory) || rootDirectory.startsWith("\\\\");
  const fileEqualsRoot = windowsPath
    ? normalizedFile.toLowerCase() === normalizedRoot.toLowerCase()
    : normalizedFile === normalizedRoot;
  const fileHasRootPrefix = windowsPath
    ? normalizedFile.toLowerCase().startsWith(rootPrefix.toLowerCase())
    : normalizedFile.startsWith(rootPrefix);
  const path = fileEqualsRoot
    ? ""
    : fileHasRootPrefix
      ? normalizedFile.slice(rootPrefix.length)
      : (windowsPath
          ? win32.relative(normalizedRoot, normalizedFile)
          : posix.relative(normalizedRoot, normalizedFile)
        ).replaceAll("\\", "/");
  return path === "" ? "." : path;
}
