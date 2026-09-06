import type { Node } from "typescript/unstable/ast";
import type { NodeHandle } from "typescript/unstable/sync";

import type { BackendNodeHandle } from "../contracts.ts";
import type { HandleRegistry } from "../handles.ts";

export type SessionNodeReference = {
  readonly deferred: boolean;
  readonly kind: Node["kind"];
  readonly path: string;
  readonly resolve: () => Node | undefined;
};

/**
 * Interns node handles by compiler identity so a deferred declaration handle
 * and a later resolved AST node of the same identity share one handle.
 */
export class NodeHandleInterner {
  private readonly nodeHandles = new Map<Node, BackendNodeHandle>();
  private readonly nodeIdentityHandles = new Map<string, BackendNodeHandle>();
  private readonly registry: HandleRegistry;
  private readonly internPath: (path: string) => string;
  private readonly resolveDeclaration: (declaration: NodeHandle) => Node | undefined;

  constructor(
    registry: HandleRegistry,
    internPath: (path: string) => string,
    resolveDeclaration: (declaration: NodeHandle) => Node | undefined
  ) {
    this.registry = registry;
    this.internPath = internPath;
    this.resolveDeclaration = resolveDeclaration;
  }

  nodeHandle(node: Node): BackendNodeHandle {
    const existing = this.nodeHandles.get(node);
    if (existing !== undefined) return existing;
    const identity = nativeNodeIdentity(node, (path, index, kind) => compilerNodeIdentity(path, index, kind));
    const interned = identity === undefined ? undefined : this.nodeIdentityHandles.get(identity);
    if (interned !== undefined) {
      this.nodeHandles.set(node, interned);
      return interned;
    }
    const sourceFile = node.getSourceFile();
    const handle = this.registry.create("node", {
      deferred: false,
      kind: node.kind,
      path: sourceFile.fileName,
      resolve: () => node,
    } satisfies SessionNodeReference);
    this.nodeHandles.set(node, handle);
    if (identity !== undefined) this.nodeIdentityHandles.set(identity, handle);
    return handle;
  }

  declarationHandle(declaration: NodeHandle): BackendNodeHandle {
    const path = this.internPath(declaration.path);
    const identity = compilerNodeIdentity(declaration.path, declaration.index, declaration.kind);
    const existing = this.nodeIdentityHandles.get(identity);
    if (existing !== undefined) return existing;
    const handle = this.registry.create("node", {
      deferred: true,
      kind: declaration.kind,
      path,
      resolve: () => this.resolveDeclaration(declaration),
    } satisfies SessionNodeReference);
    this.nodeIdentityHandles.set(identity, handle);
    return handle;
  }

  /** Drops every retained remote node; the registry already made the handles unusable. */
  clear(): void {
    this.nodeHandles.clear();
    this.nodeIdentityHandles.clear();
  }

  rememberResolvedNode(node: Node, handle: BackendNodeHandle): void {
    const existing = this.nodeHandles.get(node);
    if (existing !== undefined) return;
    this.nodeHandles.set(node, handle);
    const identity = nativeNodeIdentity(node, (path, index, kind) => compilerNodeIdentity(path, index, kind));
    if (identity !== undefined && !this.nodeIdentityHandles.has(identity)) {
      this.nodeIdentityHandles.set(identity, handle);
    }
  }
}

function compilerNodeIdentity(path: string, index: number, kind: Node["kind"]): string {
  return `${path}\0${index}\0${kind}`;
}

function nativeNodeIdentity(
  node: Node,
  identityOf: (path: string, index: number, kind: Node["kind"]) => string
): string | undefined {
  // SAFETY: TypeScript 7's native RemoteNode has an undocumented `id`
  // getter encoded as index.kind.sourceFilePath, exactly like NodeHandle.
  // Structural narrowing keeps that unstable detail inside this adapter and
  // lets synthetic nodes fall back to object-reference interning.
  const id = (node as Node & { readonly id?: unknown }).id;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the undocumented RemoteNode id is narrowed at this intern seam.
  if (typeof id !== "string") return undefined;
  const firstSeparator = id.indexOf(".");
  const secondSeparator = id.indexOf(".", firstSeparator + 1);
  if (firstSeparator <= 0 || secondSeparator <= firstSeparator + 1) return undefined;
  const index = Number(id.slice(0, firstSeparator));
  const kind = Number(id.slice(firstSeparator + 1, secondSeparator));
  const path = id.slice(secondSeparator + 1);
  if (
    !Number.isSafeInteger(index) ||
    index <= 0 ||
    kind !== node.kind ||
    path !== node.getSourceFile().path
  ) {
    return undefined;
  }
  return identityOf(path, index, node.kind);
}
