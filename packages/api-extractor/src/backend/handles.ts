import { BackendError } from "../errors.ts";
import type { BackendHandle } from "./contracts.ts";

type HandleKind = BackendHandle<string>["kind"];

type HandleContext = {
  readonly operation: string;
  readonly filePath?: string;
  readonly symbolStack?: readonly string[];
};

type HandleContextFields = { readonly filePath?: string; readonly symbolStack?: readonly string[] };
type MutableHandleContextFields = { filePath?: string; symbolStack?: readonly string[] };

/**
 * One registry is created for every extraction. The private session token
 * makes a handle from another extraction invalid even when its numeric id
 * happens to match.
 */
export class HandleRegistry {
  readonly session = Symbol("api-extractor-session");
  private nextId = 1;
  private closed = false;
  private readonly values = new Map<number, { readonly kind: string; readonly value: object }>();

  create<Tag extends HandleKind, Value extends object>(kind: Tag, value: Value): BackendHandle<Tag> {
    if (this.closed) {
      throw new BackendError({
        message: `Cannot create a ${kind} compiler handle after the extraction session closed`,
        cause: "The extraction handle registry has been cleared.",
      });
    }
    const id = this.nextId;
    this.nextId += 1;
    this.values.set(id, { kind, value });
    // SAFETY: the registry creates the branded handle and retains the matching value.
    return Object.freeze({ kind, id, session: this.session }) as BackendHandle<Tag>;
  }

  /**
   * `context` is a thunk: the operation name, file and symbol breadcrumb are
   * only assembled when a lookup fails, never on the hot path of a valid
   * handle.
   */
  get<Tag extends HandleKind, Value>(
    handle: BackendHandle<Tag>,
    expectedKind: Tag,
    context: () => HandleContext
  ): Value {
    if (this.closed) {
      throw new BackendError({
        message: `Cannot use a ${expectedKind} compiler handle after the extraction session closed`,
        cause: "The extraction handle registry has been cleared.",
        ...diagnosticFields(context()),
      });
    }
    if (!isRecord(handle)) throw invalidHandle("missing", expectedKind, context());
    if (handle.session !== this.session) throw invalidHandle("wrong-session", expectedKind, context());
    if (handle.kind !== expectedKind)
      throw invalidHandle(`wrong-kind:${handle.kind}`, expectedKind, context());
    const entry = this.values.get(handle.id);
    if (entry === undefined) throw invalidHandle("missing", expectedKind, context());
    if (entry.kind !== expectedKind) throw invalidHandle(`wrong-kind:${entry.kind}`, expectedKind, context());
    // SAFETY: an entry is inserted by create with this caller's Value type.
    return entry.value as Value;
  }

  clear(): void {
    this.closed = true;
    this.values.clear();
  }
}

function diagnosticFields(context: HandleContext): HandleContextFields {
  const fields: MutableHandleContextFields = {};
  if (context.filePath !== undefined) fields.filePath = context.filePath;
  if (context.symbolStack !== undefined) fields.symbolStack = [...context.symbolStack];
  return fields;
}
function isRecord(value: BackendHandle<string> | null | undefined): value is BackendHandle<string> {
  return (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- an opaque handle needs a runtime shape guard.
    typeof value === "object" &&
    value !== null &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- an opaque handle needs a runtime shape guard.
    typeof value.kind === "string" &&
    Number.isInteger(value.id) &&
    value.id > 0 &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- an opaque handle needs a runtime shape guard.
    typeof value.session === "symbol"
  );
}

function invalidHandle(reason: string, expectedKind: string, context: HandleContext): BackendError {
  const detail =
    reason === "missing"
      ? "The handle is missing from this extraction session."
      : reason === "wrong-session"
        ? "The handle belongs to another extraction session."
        : reason.startsWith("wrong-kind:")
          ? `The handle has the wrong kind (${reason.slice("wrong-kind:".length)}).`
          : "The handle is not valid for this extraction session.";
  return new BackendError({
    message: `Invalid ${expectedKind} compiler handle in ${context.operation}`,
    cause: detail,
    ...diagnosticFields(context),
  });
}
