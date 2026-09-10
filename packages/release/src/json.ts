import { Schema } from "effect";
import { readFileSync } from "node:fs";

function parsedJson(text: string, label: string): Schema.Json {
  try {
    // SAFETY: JSON.parse is untyped; Schema.Json is the contract.
    return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(text) as Schema.Json);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

export function decodeUnknown<A>(input: Schema.Json, schema: Schema.Codec<A>, label: string): A {
  try {
    return Schema.decodeUnknownSync(schema)(input);
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

export function decodeJson<A>(text: string, schema: Schema.Codec<A>, label: string): A {
  const parsed = parsedJson(text, label);
  if (Object.prototype.toString.call(parsed) !== "[object Object]") {
    throw new Error(`${label} is not a JSON object`);
  }
  return decodeUnknown(parsed, schema, label);
}

export function decodeJsonArray<A>(text: string, schema: Schema.Codec<A>, label: string): readonly A[] {
  const parsed = parsedJson(text, label);
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} is not a JSON array`);
  }
  return decodeUnknown(parsed, Schema.Array(schema), label);
}

export function readJson<A>(path: string, schema: Schema.Codec<A>): A {
  return decodeJson(readFileSync(path, "utf8"), schema, path);
}

export function isJsonString(value: Schema.Json | null | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}
