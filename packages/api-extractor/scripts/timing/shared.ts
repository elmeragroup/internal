import { Effect } from "effect";

import { InternalProjectExtractorTiming, timedProjectExtractorLayer } from "../../src/internal/timing.ts";
import type { TimedExtraction } from "../../src/internal/timing.ts";
import type { ExtractorOptions } from "../../src/options.ts";
import { BoundaryCheckError, checkBoundary } from "../check-boundary.ts";

export type BoundaryStatuses = {
  readonly backendLeakage: "clear" | "triggered";
  readonly durableContractLeakage: "clear" | "triggered";
};

/**
 * Both boundary stop conditions share one scan. A scan that cannot run is an
 * infrastructure failure and surfaces as one; only a scanned leak triggers the
 * stop conditions and prints the violating paths.
 */
export function boundaryStatuses(): BoundaryStatuses {
  try {
    checkBoundary();
    return { backendLeakage: "clear", durableContractLeakage: "clear" };
  } catch (cause) {
    if (cause instanceof BoundaryCheckError && cause.kind === "violation") {
      process.stderr.write(`${cause.message}\n`);
      return { backendLeakage: "triggered", durableContractLeakage: "triggered" };
    }
    throw cause;
  }
}

/** One timed extraction in a fresh public-seam project, the way every timing plan measures. */
export function timedExtraction(
  tsconfigPath: string,
  inputPath: string,
  options?: ExtractorOptions
): Promise<TimedExtraction> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const timing = yield* InternalProjectExtractorTiming;
        return yield* timing.extractModule(inputPath, options);
      }).pipe(Effect.provide(timedProjectExtractorLayer({ tsconfigPath })))
    )
  );
}
