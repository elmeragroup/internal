import { describe, expect, it } from "vitest";

import {
  assertCommit,
  assertReleaseTag,
  isReleaseTag,
  parseIntent,
  releaseRecordOwner,
  releaseTag,
  serializeIntent,
} from "../src/intent.ts";
import type { ReleaseIntent } from "../src/intent.ts";

const commit = "a".repeat(40);
const stable: ReleaseIntent = { channel: "stable", version: "0.2.0", commit };
const canary: ReleaseIntent = { channel: "canary", version: "0.3.0-canary.0", commit };

describe("release record identity", () => {
  it("parses unmarked schema-1 and marked owned schema-1", () => {
    const unmarked = { schema: 1, ...stable };
    const marked = { schema: 1, owner: releaseRecordOwner, ...stable };
    expect(parseIntent(JSON.stringify(unmarked))).toEqual(stable);
    expect(parseIntent(JSON.stringify(marked))).toEqual(stable);
    expect(releaseTag(parseIntent(JSON.stringify(unmarked)))).toBe("v0.2.0");
  });

  it("serializes new intents with the stable owner marker", () => {
    expect(JSON.parse(serializeIntent(canary))).toEqual({
      schema: 1,
      owner: releaseRecordOwner,
      channel: "canary",
      version: "0.3.0-canary.0",
      commit,
    });
    expect(parseIntent(serializeIntent(canary))).toEqual(canary);
  });

  it("rejects a foreign owner, unsupported channel, canary-as-stable, and short SHA", () => {
    const recorded = { schema: 1, channel: "stable", version: "0.2.0", commit };
    expect(() => parseIntent(JSON.stringify({ ...recorded, owner: "other-release" }))).toThrow(
      "Unsupported release intent"
    );
    expect(() => parseIntent(JSON.stringify({ ...recorded, channel: "beta" }))).toThrow();
    expect(() => parseIntent(JSON.stringify({ ...recorded, version: "0.2.0-canary.0" }))).toThrow();
    expect(() => parseIntent(JSON.stringify({ ...recorded, commit: "main" }))).toThrow();
  });

  it("accepts only v<stable> and canary-<sha> record tags", () => {
    expect(isReleaseTag("v0.2.0")).toBe(true);
    expect(isReleaseTag(`canary-${commit}`)).toBe(true);
    expect(isReleaseTag("weekly-notes")).toBe(false);
    expect(isReleaseTag("v0.2.0-canary.0")).toBe(false);
    expect(assertReleaseTag("v0.2.0")).toBe("v0.2.0");
    expect(() => assertReleaseTag("v1")).toThrow("record tag");
    expect(assertCommit(commit)).toBe(commit);
    expect(() => assertCommit("HEAD")).toThrow("full commit SHA");
  });
});
