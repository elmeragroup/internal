/**
 * Tagged failures of API artifact generation. The classes are hand-written rather
 * than `Schema.TaggedError` classes because an error-only import must stay free of
 * the Effect runtime; the packed consumer's tree-shaking check pins that. `_tag`
 * carries the same stable discriminant without a schema dependency.
 */

/** Renders the message for one batch of generation problems, keeping the structured list intact. */
function renderProblems(problems: readonly string[]): string {
  return `API artifact generation failed:\n${problems.join("\n")}`;
}

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
    super(renderProblems(problems));
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

/**
 * Collects actionable problems found while describing a project, so generation can
 * fail once with the complete list instead of at the first problem. A non-empty log
 * is reported through {@link ApiArtifactsError}.
 */
export class ProblemLog {
  private readonly entries: string[] = [];

  /** Records one rendered problem message. */
  add(problem: string): void {
    this.entries.push(problem);
  }

  /** Every problem recorded so far, in discovery order. */
  get problems(): readonly string[] {
    return this.entries;
  }
}
