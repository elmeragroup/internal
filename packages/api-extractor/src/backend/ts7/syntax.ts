import type { Node, SourceFile } from "typescript/unstable/ast";
import { isExportDeclaration, isStringLiteral } from "typescript/unstable/ast/is";

/**
 * Leaf syntax helpers shared by the module walk and the fact readers. This
 * module imports nothing from its siblings so any of them can use it without
 * forming a cycle.
 */

/** One-based file position of a node's first token, as every warning and node fact reports it. */
export type AuthoredLocation = {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
};

export function authoredLocation(
  node: Node,
  sourceFile: SourceFile = node.getSourceFile()
): AuthoredLocation {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { filePath: sourceFile.fileName, line: position.line + 1, column: position.character + 1 };
}

/**
 * Whether a statement is `export * from '…'` with a literal specifier, in the
 * requested type-only form (`undefined` accepts both forms).
 */
export function isStarExport(
  statement: Node,
  typeOnly: boolean | undefined
): statement is Node & { readonly moduleSpecifier: Node & { readonly text: string } } {
  return (
    isExportDeclaration(statement) &&
    (typeOnly === undefined || (statement.isTypeOnly === true) === typeOnly) &&
    statement.exportClause === undefined &&
    statement.moduleSpecifier !== undefined &&
    isStringLiteral(statement.moduleSpecifier)
  );
}

/** The `export` declaration a specifier belongs to, or undefined when the remote parent chain ends first. */
export function enclosingExportDeclaration(
  specifier: Node
): (Node & { readonly moduleSpecifier?: Node; readonly isTypeOnly?: boolean }) | undefined {
  // Remote specifier nodes materialize with a parent chain whose tail can be
  // absent at runtime even though the shared `Node` typing claims otherwise,
  // hence the explicit undefined-typed accumulator.
  let owner: Node | undefined = specifier.parent;
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- remote AST parents can end before the shared type says they do.
  while (owner !== undefined && !isExportDeclaration(owner)) owner = owner.parent;
  return owner;
}
