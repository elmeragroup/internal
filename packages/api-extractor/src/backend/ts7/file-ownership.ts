import type { Node } from "typescript/unstable/ast";

import type { BackendDeclarationOwnership, BackendNodeReference } from "../contracts.ts";
import { isExternalOwnership } from "../contracts.ts";
import type { TsgoFactsSession } from "./facts.ts";

/**
 * Normalized declaration ownership for the external-type policy.
 *
 * This module deliberately sits beside `facts.ts` instead of growing it: the
 * shared reader stays focused on the hot graph facts, while source-file
 * ownership is a colder classification the resolver consults through one
 * operation. The path questions it answers used to be scattered across
 * resolver modules (`/node_modules/` probes, two flavors of TypeScript
 * library-directory tests); they are normalized here so resolver code asks
 * "who owns this declaration" and never matches paths itself.
 */

export function declarationOwnership(
  session: TsgoFactsSession,
  handle: BackendNodeReference
): BackendDeclarationOwnership {
  return declarationOwnershipOfPath(session, session.nodePath(handle));
}

/** Classifies a declaration handle's path without resolving its AST subtree. */
export function declarationOwnershipOfPath(
  session: Pick<TsgoFactsSession, "ownershipOfPath">,
  filePath: string
): BackendDeclarationOwnership {
  return session.ownershipOfPath(filePath);
}

/** Whether a raw compiler declaration belongs outside the extracted project. */
export function isExternalDeclaration(
  session: Pick<TsgoFactsSession, "ownershipOfPath">,
  declaration: { readonly path: string; readonly resolve: () => Node | undefined }
): boolean {
  return isExternalOwnership(declarationOwnershipOfPath(session, declaration.path));
}

/**
 * Uses the compiler's default-library metadata for the strict library gate.
 * This is shared by the built-in-array and readonly-array facts so those
 * callers cannot accidentally reintroduce a source-path probe.
 */
export function isTypeScriptLibraryDeclaration(
  session: Pick<TsgoFactsSession, "ownershipOfPath">,
  declaration: { readonly path: string; readonly resolve: () => Node | undefined }
): boolean {
  const ownership = declarationOwnershipOfPath(session, declaration.path);
  return ownership.kind === "typescript" && ownership.library === "standard-library";
}

export type SourceFileOwnershipMetadata = {
  readonly externalLibrary: boolean;
  readonly defaultLibrary: boolean;
};

/** The compiler metadata needed to resolve ownership without materializing a node. */
export type CompilerSourceFileMetadata = {
  readonly isFromExternalLibrary: boolean;
  readonly isDefaultLibrary: boolean;
};

/**
 * Classifies a source file with the compiler's optional ownership metadata.
 * An absent metadata record deliberately keeps the path fallback in
 * `classifySourceFile`; an explicit record is authoritative, including two
 * `false` flags for a project file whose path resembles TypeScript's library.
 */
export function sourceFileOwnership(
  filePath: string,
  metadata?: CompilerSourceFileMetadata
): BackendDeclarationOwnership {
  return classifySourceFile(
    filePath,
    metadata === undefined
      ? undefined
      : {
          externalLibrary: metadata.isFromExternalLibrary,
          defaultLibrary: metadata.isDefaultLibrary,
        }
  );
}

/** Whether a source file is outside the extracted project. */
export function isExternalSourceFile(filePath: string, metadata?: CompilerSourceFileMetadata): boolean {
  return isExternalOwnership(sourceFileOwnership(filePath, metadata));
}

/**
 * Classifies one source-file path into the ownership facts the contract
 * defines. The three tests mirror the questions the resolver previously asked
 * inline: packaged sources under any `node_modules` segment are external;
 * TypeScript's own library files (`…/typescript/lib/…`, including
 * `@typescript` toolchain installs) are the standard library; and the wider
 * toolchain question accepts any TypeScript installation's lib directory.
 */
export function classifySourceFile(
  filePath: string,
  metadata?: SourceFileOwnershipMetadata
): BackendDeclarationOwnership {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const pathSegments = normalizedPath.split("/").filter((segment) => segment.length > 0);
  const pathTypescriptLibDirectory = pathSegments.some(
    (segment, index) =>
      (segment === "typescript" && pathSegments[index + 1] === "lib") ||
      (segment === "@typescript" && pathSegments[index + 2] === "lib")
  );
  const fileName = pathSegments[pathSegments.length - 1] ?? "";
  const pathExternal = pathSegments.includes("node_modules");
  const pathStandardLibrary = pathTypescriptLibDirectory && /^lib\..+\.d\.ts$/u.test(fileName);
  // Default libraries are compiler-owned even when the installation is not
  // beneath `node_modules`; they remain external to the extracted project.
  const external =
    metadata === undefined ? pathExternal : metadata.externalLibrary || metadata.defaultLibrary;
  const standardLibrary = metadata?.defaultLibrary ?? pathStandardLibrary;
  // The path shape remains useful for the wider toolchain fact, but compiler
  // metadata wins for files in the opened project. This keeps a project file
  // named `typescript/lib/lib.dom.d.ts` from becoming a compiler library while
  // retaining non-node_modules default libraries and external toolchains.
  const typescriptLibDirectory =
    pathTypescriptLibDirectory && (metadata === undefined || external || standardLibrary);
  if (standardLibrary) return { kind: "typescript", library: "standard-library" };
  if (typescriptLibDirectory) return { kind: "typescript", library: "toolchain" };
  if (external) {
    const packageName = packageNameFromPath(pathSegments);
    return packageName === undefined ? { kind: "external" } : { kind: "dependency", packageName };
  }
  return { kind: "project" };
}

/**
 * One extraction session's memo for `classifySourceFile`.
 *
 * Classification is a pure function of the path string, but the walk asks it
 * for every declaration of every symbol and the same handful of paths recur
 * for the whole session. Splitting and probing each path once per session
 * keeps the cold classification off the hot loop; the session clears the memo
 * when it closes, so nothing outlives the extraction.
 *
 * This is deliberately NOT the session's `ownershipOfPath`: that answer also
 * consults the compiler's per-file metadata, which the path name alone cannot
 * see. Callers that need the path-name question — the pre-check before a
 * metadata read, and the standard-library path test — ask this one.
 */
export class PathNameOwnershipCache {
  private readonly byPath = new Map<string, BackendDeclarationOwnership>();

  classify(filePath: string): BackendDeclarationOwnership {
    const cached = this.byPath.get(filePath);
    if (cached !== undefined) return cached;
    const ownership = classifySourceFile(filePath);
    this.byPath.set(filePath, ownership);
    return ownership;
  }

  clear(): void {
    this.byPath.clear();
  }
}

function packageNameFromPath(pathSegments: readonly string[]): string | undefined {
  // Use the innermost node_modules segment: pnpm and Yarn may place several
  // package stores in one path, while the last segment names the dependency
  // actually declaring the source file.
  const nodeModulesIndex = pathSegments.lastIndexOf("node_modules");
  if (nodeModulesIndex === -1) return undefined;
  const packageSegment = pathSegments[nodeModulesIndex + 1];
  if (packageSegment === undefined) return undefined;
  if (packageSegment.startsWith("@")) {
    const scopePackage = pathSegments[nodeModulesIndex + 2];
    return scopePackage === undefined ? undefined : `${packageSegment}/${scopePackage}`;
  }
  return packageSegment;
}
