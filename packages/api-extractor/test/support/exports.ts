import type { ExtractionResult, SemanticType } from "../../src/index.ts";

/**
 * The type of one named export in an extraction result.
 *
 * @param result - The extraction result to read.
 * @param name - The public export name.
 * @returns The export's semantic type.
 * @throws When the result does not export the name.
 */
export function exportedType(result: ExtractionResult, name: string): SemanticType {
  const entry = result.module.exports.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`The fixture does not export ${name}`);
  return entry.type;
}
