import { describe, expect, it } from "vitest";

import { parseIntent, releaseRecordOwner, serializeIntent, verifiedBundleName } from "../src/intent.ts";
import type { ReleaseIntent } from "../src/intent.ts";
import { classifyReleaseRecord } from "../src/ownership.ts";

const commit = "a".repeat(40);
const stable: ReleaseIntent = { channel: "stable", version: "0.2.0", commit };

describe("release record ownership", () => {
  it("skips a human release whose tag is not a record tag", () => {
    expect(classifyReleaseRecord("weekly-notes", "Ship notes for the week.", ["notes.md"])).toEqual({
      kind: "ignored",
    });
    expect(classifyReleaseRecord("v1", JSON.stringify({ schema: 1, ...stable }), [])).toEqual({
      kind: "ignored",
    });
  });

  it("reads a marked owned record and an unmarked schema-1 record", () => {
    expect(classifyReleaseRecord("v0.2.0", serializeIntent(stable), [])).toEqual({
      kind: "owned",
      intent: stable,
    });
    expect(classifyReleaseRecord("v0.2.0", JSON.stringify({ schema: 1, ...stable }), [])).toEqual({
      kind: "legacy",
      intent: stable,
    });
    expect(parseIntent(JSON.stringify({ schema: 1, ...stable }))).toEqual(stable);
  });

  it("fails an owned record with an invalid payload, unsupported schema, or mismatched tag", () => {
    expect(() =>
      classifyReleaseRecord(
        "v0.2.0",
        JSON.stringify({ schema: 1, owner: releaseRecordOwner, channel: "stable", version: "0.2.0" }),
        []
      )
    ).toThrow("commit is not a string");
    expect(() =>
      classifyReleaseRecord("v0.2.0", JSON.stringify({ schema: 2, owner: releaseRecordOwner, ...stable }), [])
    ).toThrow("Unsupported release intent");
    expect(() => classifyReleaseRecord(`canary-${commit}`, serializeIntent(stable), [])).toThrow(
      "Release tag does not match its intent"
    );
  });

  it("fails malformed unmarked schema-1 candidates and incomplete bundle records", () => {
    expect(() =>
      classifyReleaseRecord("v0.2.0", JSON.stringify({ schema: 1, channel: "stable", version: "0.2.0" }), [])
    ).toThrow("commit is not a string");
    expect(() => classifyReleaseRecord("v0.2.0", "not json", [verifiedBundleName])).toThrow(/JSON/);
    expect(() =>
      classifyReleaseRecord("v0.2.0", JSON.stringify({ notes: "human" }), [verifiedBundleName])
    ).toThrow("Unsupported release intent");
  });

  it("skips a clearly foreign occupant of a record tag", () => {
    expect(classifyReleaseRecord("v0.2.0", "Human release notes.", [])).toEqual({ kind: "foreign" });
    expect(
      classifyReleaseRecord("v0.2.0", JSON.stringify({ schema: 1, owner: "other-release", ...stable }), [
        verifiedBundleName,
      ])
    ).toEqual({ kind: "foreign" });
  });
});
