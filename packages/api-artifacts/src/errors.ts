export class ApiArtifactsError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`API artifact generation failed:\n${problems.join("\n")}`);
    this.name = "ApiArtifactsError";
  }
}

export class ApiArtifactsDriftError extends Error {
  constructor(readonly files: readonly string[]) {
    super(`API artifacts are missing or stale:\n${files.join("\n")}`);
    this.name = "ApiArtifactsDriftError";
  }
}

export class ProblemLog {
  private readonly entries: string[] = [];
  add(problem: string): void {
    this.entries.push(problem);
  }
  get problems(): readonly string[] {
    return this.entries;
  }
  throwIfFailed(): void {
    if (this.entries.length > 0) throw new ApiArtifactsError(this.entries);
  }
}
