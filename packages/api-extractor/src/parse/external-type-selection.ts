import type {
  BackendCompilerOperations,
  BackendExternalTypeSelection,
  BackendSymbolHandle,
} from "../backend/contracts.ts";
import { externalTypeSelectionAllowsOwnership } from "../backend/contracts.ts";
import { symbolDeclarations } from "./ownership.ts";

const noExternalTypes = { kind: "none" } as const;
const allExternalTypes = { kind: "all" } as const;

/** Copies mutable caller input once so one extraction has a stable policy. */
export function normalizeExternalTypeSelection(
  value: boolean | readonly string[]
): BackendExternalTypeSelection {
  if (value === true) return allExternalTypes;
  if (value === false || value.length === 0) return noExternalTypes;
  return { kind: "packages", packageNames: new Set(value) };
}

/**
 * Whether one symbol may be traversed under the normalized request policy.
 *
 * The `none` branch deliberately retains the original SOME-external rule.
 * Package mode is stricter: every declaration must have a known owner, and
 * every dependency owner must be selected.
 */
export function externalTypeSelectionAllowsSymbol(
  symbol: BackendSymbolHandle,
  operations: BackendCompilerOperations,
  selection: BackendExternalTypeSelection
): boolean {
  if (selection.kind === "all") return true;
  const facts = operations.symbolFacts(symbol);
  if (selection.kind === "none") {
    return !facts.declarations.some(
      (declaration) => operations.declarationOwnership(declaration).kind !== "project"
    );
  }
  const declarations = symbolDeclarations(facts);
  return (
    declarations.length > 0 &&
    declarations.every((declaration) =>
      externalTypeSelectionAllowsOwnership(operations.declarationOwnership(declaration), selection)
    )
  );
}
