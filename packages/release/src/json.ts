export type JsonObject = {
  readonly schema?: unknown;
  readonly owner?: unknown;
  readonly channel?: unknown;
  readonly version?: unknown;
  readonly commit?: unknown;
  readonly name?: unknown;
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON.parse output is untyped until the object guard.
function tag(value: unknown): string {
  return Object.prototype.toString.call(value);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON.parse output is untyped until the object guard.
function isPlainObject(value: unknown): value is JsonObject {
  return tag(value) === "[object Object]";
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON.parse output is untyped until the object guard.
export function isString(value: unknown): value is string {
  return tag(value) === "[object String]";
}

export function parseJsonObject(text: string, label: string): JsonObject {
  // SAFETY: JSON.parse is untyped; the object guard below is the contract.
  const parsed = JSON.parse(text) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return parsed;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON object fields are untyped until asString.
export function asString(value: unknown, label: string): string {
  if (!isString(value)) {
    throw new Error(`${label} is not a string`);
  }
  return value;
}
