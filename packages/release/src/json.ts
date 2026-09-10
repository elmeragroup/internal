import { Schema } from "effect";
import { readFileSync } from "node:fs";

function parseJson(text: string, label: string): Schema.Json {
  try {
    return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(text));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

export function decodeUnknown<A>(input: Schema.Json, schema: Schema.Codec<A>, label: string): A {
  try {
    return Schema.decodeUnknownSync(schema)(input);
  } catch (error) {
    throw new Error(`${label} is invalid`, { cause: error });
  }
}

export function decodeJson<A>(text: string, schema: Schema.Codec<A>, label: string): A {
  return decodeUnknown(parseJson(text, label), schema, label);
}

export function readJson<A>(path: string, schema: Schema.Codec<A>): A {
  return decodeJson(readFileSync(path, "utf8"), schema, path);
}
