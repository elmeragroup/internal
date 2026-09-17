import { Schema } from "effect";

/** The one runtime `typeof` in this module — untrusted thrown values are narrowed at this seam. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- untrusted thrown values are narrowed at this seam.
function runtimeType(value: unknown): string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- untrusted thrown values are narrowed at this seam.
  return typeof value;
}

/**
 * Errors cross the extractor boundary as data.  In particular, never retain a
 * checker/AST object (or an opaque backend handle) as a cause: those objects
 * are process-local and can be both cyclic and enormous.
 */
export function safeCause(cause: unknown): string {
  try {
    switch (runtimeType(cause)) {
      case "string":
        return String(cause);
      case "undefined":
        return "undefined";
      case "number":
      case "boolean":
      case "bigint":
        return String(cause);
      case "object": {
        if (cause === null) return "null";
        if (cause instanceof Error) {
          const code = "code" in cause ? cause.code : undefined;
          const codeKind = runtimeType(code);
          const codeSuffix = codeKind === "string" || codeKind === "number" ? ` [${String(code)}]` : "";
          return `${cause.name}: ${cause.message}${codeSuffix}`;
        }
        // SAFETY: this branch only reads two optional primitive diagnostic fields;
        // the object itself never crosses a durable package boundary.
        const value = cause as { readonly _tag?: unknown; readonly message?: unknown };
        const tag = runtimeType(value._tag) === "string" ? String(value._tag) : "BackendFailure";
        const message =
          runtimeType(value.message) === "string" ? String(value.message) : "Compiler operation failed";
        return `${tag}: ${message}`;
      }
      default:
        return Object.prototype.toString.call(cause);
    }
  } catch {
    return "Unknown compiler failure";
  }
}

/** The TypeScript configuration could not be read, parsed, or opened. */
export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  tsconfigPath: Schema.String,
  message: Schema.String,
  cause: Schema.String,
}) {}

/**
 * A compiler operation failed outside the model: the defect fields name the operation, file,
 * and resolver breadcrumb current when it threw.
 */
export class BackendError extends Schema.TaggedError<BackendError>()("BackendError", {
  message: Schema.String,
  cause: Schema.String,
  operation: Schema.optionalKey(Schema.String),
  filePath: Schema.optionalKey(Schema.String),
  symbolStack: Schema.optionalKey(Schema.Array(Schema.String)),
}) {}

/** The requested file is not a module of the configured TypeScript project. */
export class FileNotInProgramError extends Schema.TaggedError<FileNotInProgramError>()(
  "FileNotInProgramError",
  {
    filePath: Schema.String,
    message: Schema.String,
  }
) {}

/** The semantic resolver could not model a file, including failures thrown by user callbacks. */
export class ExtractError extends Schema.TaggedError<ExtractError>()("ExtractError", {
  filePath: Schema.String,
  symbolStack: Schema.Array(Schema.String),
  message: Schema.String,
  cause: Schema.String,
}) {}
