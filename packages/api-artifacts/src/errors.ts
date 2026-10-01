/**
 * Tagged failures of API artifact generation. The classes are hand-written rather
 * than `Schema.TaggedError` classes because an error-only import must stay free of
 * the Effect runtime; the packed consumer's tree-shaking check pins that. `_tag`
 * carries the same stable discriminant without a schema dependency.
 */

/**
 * Expected failure of `generateApiArtifacts`: the project could not be turned into
 * artifacts. `problems` keeps every rendered problem as structured data so callers
 * can branch on `_tag` and report them individually; `message` renders the batch.
 */
export class ApiArtifactsError extends Error {
  readonly _tag = "ApiArtifactsError" as const;

  /** Every problem found while describing the project, in discovery order. */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`API artifact generation failed:\n${problems.join("\n")}`);
    this.name = "ApiArtifactsError";
    this.problems = [...problems];
  }
}

/**
 * Expected failure of `generateApiArtifacts({ mode: "check" })`: committed artifacts
 * are missing or stale. `files` keeps the absolute output paths as structured data;
 * `message` renders the batch. No files are written on this path.
 */
export class ApiArtifactsDriftError extends Error {
  readonly _tag = "ApiArtifactsDriftError" as const;

  /** Absolute paths of the missing or stale artifact files, in generation order. */
  readonly files: readonly string[];

  constructor(files: readonly string[]) {
    super(`API artifacts are missing or stale:\n${files.join("\n")}`);
    this.name = "ApiArtifactsDriftError";
    this.files = [...files];
  }
}
