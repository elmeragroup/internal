import { Context } from "effect";
import type { Effect } from "effect";

import type { BackendTiming } from "../backend/contracts.ts";
import type { BackendError } from "../errors.ts";
import type { ExtractError, FileNotInProgramError } from "../errors.ts";
import type { ExtractionResult } from "../extractor.ts";
import type { ExtractorOptions, OpenProjectOptions } from "../options.ts";

/**
 * Options understood by the package-owned project factory.  Compiler timing
 * is an evidence concern, so this type is intentionally kept out of the
 * package entry point and is only consumed by the internal timing seam.
 */
export type InternalOpenProjectOptions = OpenProjectOptions & {
  readonly collectTiming?: boolean;
};

export type InternalTimedExtraction = {
  readonly result: ExtractionResult;
  /** The backend's own timing shape; the evidence seam adds nothing to it. */
  readonly timing: BackendTiming;
};

export type InternalTimingMethod = (
  filePath: string,
  options?: ExtractorOptions
) => Effect.Effect<InternalTimedExtraction, BackendError | FileNotInProgramError | ExtractError>;

export type InternalTimingService = {
  readonly extractModule: InternalTimingMethod;
};

/** Private evidence service; deliberately not re-exported from the package index. */
export class InternalProjectExtractorTiming extends Context.Service<
  InternalProjectExtractorTiming,
  InternalTimingService
>()("elmera/api-extractor/InternalProjectExtractorTiming") {}
