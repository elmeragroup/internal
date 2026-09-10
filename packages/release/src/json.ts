import { readFileSync } from "node:fs";

export type JsonObject = {
  readonly schema?: unknown;
  readonly owner?: unknown;
  readonly channel?: unknown;
  readonly version?: unknown;
  readonly commit?: unknown;
  readonly name?: unknown;
  readonly body?: unknown;
  readonly tag_name?: unknown;
  readonly assets?: unknown;
  readonly draft?: unknown;
  readonly id?: unknown;
  readonly object?: unknown;
  readonly type?: unknown;
  readonly sha?: unknown;
  readonly state?: unknown;
  readonly size?: unknown;
  readonly head?: unknown;
  readonly base?: unknown;
  readonly merged_at?: unknown;
  readonly merge_commit_sha?: unknown;
  readonly repo?: unknown;
  readonly full_name?: unknown;
  readonly ref?: unknown;
  readonly versions?: unknown;
  readonly dist?: unknown;
  readonly integrity?: unknown;
  readonly elmeraRelease?: unknown;
  readonly gitHead?: unknown;
  readonly "dist-tags"?: unknown;
  readonly releases?: unknown;
  readonly newVersion?: unknown;
  readonly status?: unknown;
  readonly archiveReportSha256?: unknown;
  readonly archive?: unknown;
  readonly bytes?: unknown;
  readonly sha256?: unknown;
  readonly baseBranch?: unknown;
  readonly packageManager?: unknown;
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

export function readJsonObject(path: string): JsonObject {
  return parseJsonObject(readFileSync(path, "utf8"), path);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON object fields are untyped until asString.
export function asString(value: unknown, label: string): string {
  if (!isString(value)) {
    throw new Error(`${label} is not a string`);
  }
  return value;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON object fields are untyped until asRecord.
export function asRecord(value: unknown, label: string): JsonObject {
  if (!isPlainObject(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON object fields are untyped until asInteger.
export function asInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (value !== number || !Number.isSafeInteger(number)) throw new Error(`${label} is not an integer`);
  return number;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON arrays are untyped until asRecordArray.
export function asRecordArray(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} is not an array`);
  }
  return value.map((entry, index) => asRecord(entry, `${label}[${String(index)}]`));
}

export function parseJsonArray(text: string, label: string): JsonObject[] {
  // SAFETY: JSON.parse is untyped; the array guard below is the contract.
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} is not a JSON array`);
  }
  return asRecordArray(parsed, label);
}
