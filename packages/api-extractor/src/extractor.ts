import { Context, Effect, Layer, Schema } from "effect";

import type {
  BackendCompilerOperations,
  BackendExtractionSession,
  BackendProject,
} from "./backend/contracts.ts";
import { disabledTiming } from "./backend/contracts.ts";
import { CompilerBackend } from "./backend/service.ts";
import { BackendError, ExtractError, FileNotInProgramError, safeCause } from "./errors.ts";
import type { ConfigError } from "./errors.ts";
import { InternalProjectExtractorTiming } from "./internal/project-options.ts";
import type { InternalOpenProjectOptions, InternalTimedExtraction } from "./internal/project-options.ts";
import { ExtractionResultSchema } from "./model.ts";
import { definedFields } from "./optional-fields.ts";
import type { ExtractorOptions, OpenProjectOptions } from "./options.ts";
import { normalizeExternalTypeSelection } from "./parse/external-type-selection.ts";
import { ResolverFailure } from "./parse/resolver-failure.ts";
import { readModuleDraft, resolveModuleDraft } from "./parser.ts";

export type ExtractionResult = typeof ExtractionResultSchema.Type;

type ExtractionErrors = BackendError | FileNotInProgramError | ExtractError;

export type ProjectExtractorService = {
  readonly extractModule: (
    filePath: string,
    options?: ExtractorOptions
  ) => Effect.Effect<ExtractionResult, ExtractionErrors>;
};

export class ProjectExtractor extends Context.Service<ProjectExtractor, ProjectExtractorService>()(
  "elmera/api-extractor/ProjectExtractor"
) {
  static live(options: OpenProjectOptions): Layer.Layer<ProjectExtractor, ConfigError | BackendError> {
    return projectExtractorLayer(options).pipe(Layer.provide(CompilerBackend.layer));
  }
}

/** The one opened backend project every service built from the same layer shares. */
class OpenedProject extends Context.Service<OpenedProject, BackendProject>()(
  "elmera/api-extractor/OpenedProject"
) {}

function openedProjectLayer(
  options: InternalOpenProjectOptions
): Layer.Layer<OpenedProject, ConfigError | BackendError, CompilerBackend> {
  return Layer.effect(
    OpenedProject,
    Effect.gen(function* () {
      const backend = yield* CompilerBackend;
      return yield* backend.openProject(options);
    })
  );
}

const extractorLayer: Layer.Layer<ProjectExtractor, never, OpenedProject> = Layer.effect(
  ProjectExtractor,
  Effect.map(OpenedProject, (project) => ({
    extractModule: (filePath, options) =>
      extractModule(project, filePath, options).pipe(Effect.map(({ result }) => result)),
  }))
);

/** @internal Test seam for injecting a package-owned backend implementation. */
export function projectExtractorLayer(
  options: OpenProjectOptions
): Layer.Layer<ProjectExtractor, ConfigError | BackendError, CompilerBackend> {
  const { tsconfigPath, cwd, fileSystem } = options;
  return extractorLayer.pipe(Layer.provide(openedProjectLayer({ tsconfigPath, cwd, fileSystem })));
}

/** @internal Evidence-only factory; timing is deliberately absent from the public service. */
export function projectExtractorLayerWithTiming(
  options: InternalOpenProjectOptions
): Layer.Layer<
  ProjectExtractor | InternalProjectExtractorTiming,
  ConfigError | BackendError,
  CompilerBackend
> {
  const timingLayer = Layer.effect(
    InternalProjectExtractorTiming,
    Effect.map(OpenedProject, (project) => ({
      extractModule: (filePath, extractorOptions) => extractModule(project, filePath, extractorOptions),
    }))
  );
  return Layer.merge(extractorLayer, timingLayer).pipe(Layer.provide(openedProjectLayer(options)));
}

function openExtraction(project: BackendProject, options: ExtractorOptions | undefined) {
  return Effect.acquireRelease(
    Effect.try({
      try: () =>
        project.openExtraction({
          externalTypes: normalizeExternalTypeSelection(options?.includeExternalTypes ?? false),
        }),
      catch: (cause) => classifyThrown(cause, { filePath: "<session>", operation: "openExtraction" }),
    }),
    (session) => Effect.try(() => session.close()).pipe(Effect.ignore)
  );
}

const extractModule = Effect.fn("ProjectExtractor.extractModule")(function* (
  project: BackendProject,
  filePath: string,
  options: ExtractorOptions | undefined
) {
  const session = guardedExtractionSession(yield* openExtraction(project, options), filePath);
  const draft = yield* Effect.try({
    try: () => readModuleDraft(session, filePath),
    catch: (cause) => classifyThrown(cause, { filePath, operation: "readModule" }),
  });
  const resolved = yield* Effect.try({
    try: () => resolveModuleDraft(session, draft, filePath, options),
    catch: (cause) => classifyThrown(cause, { filePath, operation: "resolveModule", fallback: "extract" }),
  });
  // The resolver violating its own schema is a bug, not user input.
  const result = yield* Schema.decodeUnknownEffect(ExtractionResultSchema)(resolved).pipe(Effect.orDie);
  const timing = yield* Effect.try({
    try: () => project.getTimingInfo?.() ?? disabledTiming(),
    catch: (cause) => classifyThrown(cause, { filePath, operation: "getTimingInfo" }),
  });
  return { result, timing } satisfies InternalTimedExtraction;
}, Effect.scoped);

type ThrownContext = {
  readonly filePath: string;
  readonly operation: string;
  readonly symbolStack?: readonly string[];
  /** What an unrecognised throw becomes: a compiler fault, or a resolver/policy fault. */
  readonly fallback?: "backend" | "extract";
};

/**
 * Classifies a value thrown across the synchronous seam. Typed errors pass
 * through; a BackendError gains whichever of operation, file and symbol stack
 * it lacks; a ResolverFailure keeps its breadcrumb; anything else becomes the
 * fallback error for the phase that threw it.
 */
function classifyThrown(cause: unknown, context: ThrownContext): ExtractionErrors {
  if (cause instanceof FileNotInProgramError || cause instanceof ExtractError) return cause;
  if (cause instanceof BackendError) return withThrownContext(cause, context);
  if (cause instanceof ResolverFailure || context.fallback === "extract") {
    const resolver = cause instanceof ResolverFailure ? cause : undefined;
    return new ExtractError({
      filePath: context.filePath,
      symbolStack: [context.filePath, ...(resolver?.symbolStack ?? [])],
      message: `Could not parse or model ${context.filePath}${resolver === undefined ? "" : `: ${resolver.message}`}`,
      cause: safeCause(resolver?.cause ?? cause),
    });
  }
  const symbolStack = context.symbolStack ?? [];
  return new BackendError({
    message: `Compiler operation ${context.operation} failed while extracting ${context.filePath}`,
    cause: safeCause(cause),
    operation: context.operation,
    filePath: context.filePath,
    ...definedFields({ symbolStack: symbolStack.length === 0 ? undefined : [...symbolStack] }),
  });
}

function withThrownContext(error: BackendError, context: ThrownContext): BackendError {
  const symbolStack = context.symbolStack ?? [];
  const existingStack = error.symbolStack;
  const needsSymbolStack =
    symbolStack.length > 0 && (existingStack === undefined || existingStack.length === 0);
  if (error.operation !== undefined && error.filePath !== undefined && !needsSymbolStack) return error;
  return new BackendError({
    message: error.message,
    cause: error.cause,
    operation: error.operation ?? context.operation,
    filePath: error.filePath ?? context.filePath,
    ...definedFields({
      symbolStack: needsSymbolStack
        ? [...symbolStack]
        : existingStack === undefined
          ? undefined
          : [...existingStack],
    }),
  });
}

type CompilerOperationName = Exclude<keyof BackendCompilerOperations, "setErrorContext">;
type CompilerOperation = NonNullable<BackendCompilerOperations[CompilerOperationName]>;

/**
 * Every compiler operation the guard wraps. A `Record` over the operation
 * names makes the list exhaustive at the type level: adding an operation to
 * `BackendCompilerOperations` without listing it here is a compile error, as
 * is listing a name the contract does not have.
 */
const guardedCompilerOperations = {
  typeOfSymbol: true,
  typeAtNode: true,
  typeFacts: true,
  symbolFacts: true,
  symbolOrigin: true,
  declaringParentIsClass: true,
  documentationOfSymbol: true,
  enumFacts: true,
  nodeFacts: true,
  nodeKind: true,
  typeNameFacts: true,
  signaturesOfType: true,
  constructSignaturesOfType: true,
  declarationOwnership: true,
  signatureFacts: true,
  documentationOfNode: true,
  documentationOfParameter: true,
  propertiesOfType: true,
  propertyType: true,
  indexSignaturesOfType: true,
  baseConstraintOfType: true,
  isArrayType: true,
  isReadonlyType: true,
  typeToString: true,
} satisfies Record<CompilerOperationName, true>;
// SAFETY: the literal satisfies `Record<CompilerOperationName, true>`, so its keys are exactly the operation names.
const compilerOperationNames = Object.keys(guardedCompilerOperations) as readonly CompilerOperationName[];

/**
 * Wraps the complete backend session once per extraction. Every compiler
 * operation that throws surfaces as a BackendError carrying the operation
 * name, the current file and the resolver's symbol stack, so transport and
 * compiler failures stay BackendErrors while user callbacks still become
 * ExtractErrors at the shell.
 */
function guardedExtractionSession(
  session: BackendExtractionSession,
  filePath: string
): BackendExtractionSession {
  let symbolStack: readonly string[] = [];
  let currentFilePath = filePath;
  const guard =
    <Arguments extends readonly unknown[], Result>(
      operation: string,
      run: (...arguments_: Arguments) => Result,
      operationFilePath?: (...arguments_: Arguments) => string
    ) =>
    (...arguments_: Arguments): Result => {
      const operationPath = operationFilePath?.(...arguments_) ?? currentFilePath;
      try {
        return run(...arguments_);
      } catch (cause) {
        throw classifyThrown(cause, { filePath: operationPath, operation, symbolStack });
      }
    };

  const compiler = session.compiler;
  const guardedOperations: Partial<Record<CompilerOperationName, CompilerOperation>> = {};
  for (const name of compilerOperationNames) {
    const operation = compiler[name];
    // SAFETY: `operation` is the session's own method for `name`; the guard
    // forwards the exact arguments the typed caller supplied and returns the
    // same result, so the wrapped function keeps that method's signature.
    const uniform = operation as (
      ...operationArguments: Parameters<CompilerOperation>
    ) => ReturnType<CompilerOperation>;
    // SAFETY: `guard` preserves `uniform`'s signature, which is the method's own.
    guardedOperations[name] = guard(name, uniform) as CompilerOperation;
  }
  const setErrorContext = (next: readonly string[]) => {
    symbolStack = [...next];
    guard("setErrorContext", () => compiler.setErrorContext(next))();
  };

  return {
    readModule: guard(
      "readModule",
      (modulePath) => session.readModule(modulePath),
      (modulePath) => {
        currentFilePath = modulePath;
        return modulePath;
      }
    ),
    // SAFETY: every operation name was copied above with its own signature.
    compiler: { ...guardedOperations, setErrorContext } as BackendCompilerOperations,
    resolveModule: guard(
      "resolveModule",
      (specifier, containingFile) => session.resolveModule(specifier, containingFile),
      (_specifier, containingFile) => {
        currentFilePath = containingFile;
        return containingFile;
      }
    ),
    close: () => session.close(),
  };
}
