import { Schema } from "effect";

import { isReleaseTag, parseIntent, releaseRecordOwner, releaseTag, verifiedBundleName } from "./intent.ts";
import type { ReleaseIntent } from "./intent.ts";
import { decodeJson } from "./json.ts";

export type ReleaseRecordClassification =
  | { kind: "ignored" }
  | { kind: "foreign" }
  | { kind: "owned"; intent: ReleaseIntent }
  | { kind: "legacy"; intent: ReleaseIntent };

const IntentProbe = Schema.Struct({
  schema: Schema.optionalKey(Schema.Json),
  owner: Schema.optionalKey(Schema.Json),
});
type IntentProbe = typeof IntentProbe.Type;

function tryParseBody(body: string): IntentProbe | undefined {
  try {
    return decodeJson(body, IntentProbe, "release body");
  } catch {
    return undefined;
  }
}

function intentMatchingTag(body: string, tag: string): ReleaseIntent {
  const intent = parseIntent(body);
  if (releaseTag(intent) !== tag) throw new Error("Release tag does not match its intent");
  return intent;
}

function clearlyForeignIdentity(parsed: IntentProbe | undefined): boolean {
  return parsed !== undefined && parsed.owner !== undefined && parsed.owner !== releaseRecordOwner;
}

export function classifyReleaseRecord(
  tag: string,
  body: string,
  assetNames: readonly string[]
): ReleaseRecordClassification {
  if (!isReleaseTag(tag)) return { kind: "ignored" };
  const parsed = tryParseBody(body);
  if (parsed?.owner === releaseRecordOwner) {
    return { kind: "owned", intent: intentMatchingTag(body, tag) };
  }
  if (parsed?.schema === 1 && parsed.owner === undefined) {
    return { kind: "legacy", intent: intentMatchingTag(body, tag) };
  }
  if (assetNames.includes(verifiedBundleName) && !clearlyForeignIdentity(parsed)) {
    return { kind: "legacy", intent: intentMatchingTag(body, tag) };
  }
  return { kind: "foreign" };
}
