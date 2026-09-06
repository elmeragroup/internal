import { Context, Effect, Layer } from "effect";
import type { Scope } from "effect";

import { BackendError, ConfigError, safeCause } from "../errors.ts";
import type { InternalOpenProjectOptions } from "../internal/project-options.ts";
import type { BackendProject } from "./contracts.ts";
import { openTsgoProject } from "./ts7/project.ts";

/**
 * The compiler backend seam. `openProject` owns the project's lifetime: the
 * returned effect acquires the native project and releases it with the scope,
 * so a replacement backend gets release for free.
 */
export class CompilerBackend extends Context.Service<
  CompilerBackend,
  {
    readonly openProject: (
      options: InternalOpenProjectOptions
    ) => Effect.Effect<BackendProject, ConfigError | BackendError, Scope.Scope>;
  }
>()("elmera/api-extractor/CompilerBackend") {
  static readonly layer: Layer.Layer<CompilerBackend> = Layer.succeed(CompilerBackend, {
    openProject: (options) =>
      Effect.acquireRelease(
        Effect.try({
          try: () => openTsgoProject(options),
          catch: (cause) => toOpenError(options.tsconfigPath, cause),
        }),
        // A throwing finalizer would mask the primary failure; the project is gone either way.
        (project) => Effect.try(() => project.close()).pipe(Effect.ignore)
      ),
  });
}

function toOpenError(tsconfigPath: string, cause: unknown): ConfigError | BackendError {
  if (cause instanceof ConfigError || cause instanceof BackendError) return cause;
  return new BackendError({
    message: `Could not start TypeScript project ${tsconfigPath}`,
    cause: safeCause(cause),
    filePath: tsconfigPath,
  });
}
