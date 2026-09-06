import type { Node, SyntaxKind } from "typescript/unstable/ast";
import { SignatureKind } from "typescript/unstable/sync";

import type { BackendSignatureHandle, BackendTypeHandle } from "../contracts.ts";
import type { TsgoFactsSession } from "./facts.ts";

/**
 * Normalized facts for class-shaped types. This module deliberately sits beside
 * `facts.ts` instead of growing it: the shared reader stays focused on the hot
 * graph facts, while the colder construct-signature and authored-name reads
 * stay cohesive here. Documentation normalization lives in `documentation.ts`.
 */

export function constructSignaturesOfType(
  session: TsgoFactsSession,
  handle: BackendTypeHandle
): readonly BackendSignatureHandle[] {
  const type = session.type(handle, "constructSignaturesOfType");
  return session.checker
    .getSignaturesOfType(type, SignatureKind.Construct)
    .map((signature) => session.signatureHandle(signature));
}

/**
 * Reports a symbol under the name the author wrote.
 *
 * ECMAScript private names reach the checker escaped as their member-map key
 * (`__#2@#secret`); the authored spelling is the trailing `#`-prefixed
 * segment, which is what visibility policy and public output need to see.
 */
export function authoredSymbolName(name: string): string {
  const match = /^__#\d+@#(.+)$/u.exec(name);
  return match === null ? name : `#${match[1]}`;
}

/**
 * Reads the modifier slots a declaration materializes with.
 *
 * SAFETY: the shared declaration typing omits the modifier list that every
 * function, class, and property declaration carries at runtime. This is the
 * one copy of that read: the fact reader's flag mapping (`facts.ts`
 * `modifierFlags`) and the module walk's default-export detection both go
 * through it.
 */
export function declarationModifiers(node: Node): readonly { readonly kind: SyntaxKind }[] {
  // SAFETY: the shared declaration typing omits the modifier list that every
  // materialized function, class, and property declaration carries at runtime.
  return (node as Node & { readonly modifiers?: readonly { readonly kind: SyntaxKind }[] }).modifiers ?? [];
}
