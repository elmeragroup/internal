import type { Node, SourceFile } from "typescript/unstable/ast";
import type { Project } from "typescript/unstable/sync";

import type { CompilerDeclaration } from "./declarations.ts";

type SourceFileTree = SourceFile & {
  readonly getOrCreateNodeAtIndex: (index: number) => Node;
};

/**
 * Session-owned source-file trees. NodeHandle.resolve and Program.getSourceFile
 * both fetch one whole file, so a file is fetched at most once per session and
 * later node lookups stay on the remembered tree. The map is dropped at session
 * close; the compiler's project-scoped SourceFileCache outlives it.
 */
export class SessionFileTrees {
  private readonly trees = new Map<string, SourceFileTree>();
  private readonly project: Project;
  private readonly isExternalPath: (path: string) => boolean;
  private readonly isSelectedPath: (path: string) => boolean;

  /**
   * `isExternalPath` bounds whole-module reads to the project; `isSelectedPath`
   * says which files the extraction's external-type selection lets the backend
   * materialize on its own initiative.
   */
  constructor(
    project: Project,
    isExternalPath: (path: string) => boolean,
    isSelectedPath: (path: string) => boolean
  ) {
    this.project = project;
    this.isExternalPath = isExternalPath;
    this.isSelectedPath = isSelectedPath;
  }

  /** Whole-module reads stay inside project ownership; excluded files are never read as modules. */
  sourceFile(filePath: string): SourceFile | undefined {
    const existing = this.trees.get(filePath);
    if (existing !== undefined) return existing;
    if (this.isExternalPath(filePath)) return undefined;
    const sourceFile = this.project.program.getSourceFile(filePath);
    if (sourceFile === undefined) return undefined;
    return this.remember(sourceFile);
  }

  /**
   * Materializes a declaration the parser holds a handle for. The parser has
   * already applied its dependency policy to that handle, so the read is
   * honored for any owner; a tree fetched once serves every later lookup.
   */
  resolve(declaration: CompilerDeclaration): Node | undefined {
    const tree = this.trees.get(declaration.path);
    if (tree !== undefined) return tree.getOrCreateNodeAtIndex(declaration.index);
    const node = declaration.resolve(this.project);
    if (node !== undefined) this.remember(node.getSourceFile());
    return node;
  }

  /**
   * Materializes a declaration the backend reaches on its own while answering
   * a fact (a value's declaration site, an enum member, an index signature, a
   * parameter's JSDoc). Files the selection excludes are never fetched for
   * that; the fact degrades to what the checker knows without the node.
   */
  resolveSelected(declaration: CompilerDeclaration): Node | undefined {
    if (!this.trees.has(declaration.path) && !this.isSelectedPath(declaration.path)) return undefined;
    return this.resolve(declaration);
  }

  clear(): void {
    this.trees.clear();
  }

  private remember(sourceFile: SourceFile): SourceFileTree {
    // SAFETY: Program.getSourceFile returns a RemoteSourceFile. Index lookup is
    // the same operation NodeHandle.resolve uses after fetching the binary tree.
    const tree = sourceFile as SourceFileTree;
    this.trees.set(sourceFile.fileName, tree);
    if (sourceFile.path !== sourceFile.fileName) this.trees.set(sourceFile.path, tree);
    return tree;
  }
}
