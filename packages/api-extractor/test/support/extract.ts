import { Effect } from "effect";

import { ProjectExtractor } from "../../src/index.ts";
import type { ExtractionResult, ExtractorOptions, OpenProjectOptions } from "../../src/index.ts";

export { fixtureRoot } from "./temp-dirs.ts";

/** Opens one project, extracts one module through the public service, and closes the project. */
export function extractFixture(
  project: OpenProjectOptions,
  filePath: string,
  options?: ExtractorOptions
): Promise<ExtractionResult> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const extractor = yield* ProjectExtractor;
        return yield* extractor.extractModule(filePath, options);
      }).pipe(Effect.provide(ProjectExtractor.live(project)))
    )
  );
}
