import { Effect } from "effect";
import { resolve } from "node:path";

import type {
  BackendExtractionSession,
  BackendModuleDraft,
  BackendNodeHandle,
  BackendSymbolHandle,
} from "../../src/backend/contracts.ts";
import { openTsgoProject } from "../../src/backend/ts7/project.ts";
import type { ComponentSourceRequest, ComponentSourceResult } from "../../src/component-sources.ts";
import { ProjectExtractor } from "../../src/index.ts";

export const componentSourceFixtures = resolve(import.meta.dirname, "../fixtures/component-source");
const tsconfigPath = resolve(componentSourceFixtures, "tsconfig.json");

/** One fixture module's absolute path. */
export function componentSourceFixture(fileName: string): string {
  return resolve(componentSourceFixtures, fileName);
}

/** Inspects requests through the public service against the component-source fixture project. */
export function inspectNative(
  filePath: string,
  requests: readonly ComponentSourceRequest[],
  projectConfig = tsconfigPath
): Promise<readonly ComponentSourceResult[]> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const extractor = yield* ProjectExtractor;
        return yield* extractor.inspectComponentSources(filePath, requests);
      }).pipe(Effect.provide(ProjectExtractor.live({ tsconfigPath: projectConfig })))
    )
  );
}

/** Opens a component-sources extraction session on the fixture project for one module. */
export function withSession(
  filePath: string,
  run: (session: BackendExtractionSession, draft: BackendModuleDraft) => void
): void {
  const project = openTsgoProject({ tsconfigPath });
  try {
    const session = project.openExtraction({ componentSources: true });
    try {
      run(session, session.readModule(filePath));
    } finally {
      session.close();
    }
  } finally {
    project.close();
  }
}

export function exportSymbol(draft: BackendModuleDraft, name: string): BackendSymbolHandle {
  const symbol = draft.exports.find((entry) => entry.name === name)?.symbol;
  if (symbol === undefined) throw new Error(`Missing export ${name}`);
  return symbol;
}

export function primaryNode(
  session: BackendExtractionSession,
  symbol: BackendSymbolHandle
): BackendNodeHandle {
  const facts = session.compiler.symbolFacts(symbol);
  const declaration = facts.valueDeclaration ?? facts.declarations[0];
  if (declaration === undefined) throw new Error("Missing declaration");
  return declaration;
}
