import { Schema } from "effect";
import { readFileSync } from "node:fs";

/** Parses `text` as JSON and decodes it. Throws `"<label> is not valid JSON"` or `"<label> is invalid"`. */
export function decodeJson<A>(text: string, schema: Schema.Codec<A>, label: string): A {
  try {
    return Schema.decodeUnknownSync(schema)(JSON.parse(text));
  } catch (error) {
    const problem = error instanceof SyntaxError ? "is not valid JSON" : "is invalid";
    throw new Error(`${label} ${problem}`, { cause: error });
  }
}

/** Reads a UTF-8 file and decodes its JSON, labeling failures with the file path. */
export function readJson<A>(path: string, schema: Schema.Codec<A>): A {
  return decodeJson(readFileSync(path, "utf8"), schema, path);
}
