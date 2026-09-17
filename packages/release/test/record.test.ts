import { describe, expect, it } from "vitest";

import { assertCommit, isCommit } from "../src/intent.ts";
import type { ReleaseIntent } from "../src/intent.ts";
import {
  assertReleaseTag,
  classifyReleaseRecord,
  isReleaseTag,
  parseIntent,
  releaseArchiveName,
  releaseRecordOwner,
  releaseTag,
  serializeIntent,
} from "../src/record.ts";
import { commit, releaseIntent } from "./lib/release-fixtures.ts";

const stable: ReleaseIntent = releaseIntent("0.2.0");
const canary: ReleaseIntent = releaseIntent("0.3.0-canary.0");

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
      "release intent is invalid"
    );
    expect(() => parseIntent(JSON.stringify({ ...recorded, channel: "beta" }))).toThrow(
      "release intent is invalid"
    );
    expect(() => parseIntent(JSON.stringify({ ...recorded, version: "0.2.0-canary.0" }))).toThrow(
      "Expected a stable version"
    );
    expect(() => parseIntent(JSON.stringify({ ...recorded, commit: "main" }))).toThrow(
      "Expected a full commit SHA"
    );
  });

  it("accepts only v<stable> and canary-<sha> record tags", () => {
    expect(isReleaseTag("v0.2.0")).toBe(true);
    expect(isReleaseTag(`canary-${commit}`)).toBe(true);
    expect(isReleaseTag("weekly-notes")).toBe(false);
    expect(isReleaseTag("v0.2.0-canary.0")).toBe(false);
    expect(assertReleaseTag("v0.2.0")).toBe("v0.2.0");
    expect(() => assertReleaseTag("v1")).toThrow("record tag");
    expect(assertCommit(commit)).toBe(commit);
  });

  it.each(["HEAD", "origin/main", "0".repeat(39), "0".repeat(41), "A".repeat(40), "0123456f"])(
    "rejects %s as a commit SHA",
    (invalid) => {
      expect(isCommit(invalid)).toBe(false);
      expect(() => assertCommit(invalid)).toThrow(`Expected a full commit SHA; received ${invalid}`);
    }
  );
});

describe("release record classification", () => {
  // Cases the store suite does not reach through fixture fetch responses. Every other ownership rule
  // is proven through ReleaseStore.find/create/reservedCanaryVersions in store.test.ts.
  it("ignores a valid intent body whose tag is not a record tag", () => {
    expect(classifyReleaseRecord("v1", JSON.stringify({ schema: 1, ...stable }), [])).toEqual({
      kind: "ignored",
    });
  });

  it("fails an owned record whose payload is missing a field", () => {
    expect(() =>
      classifyReleaseRecord(
        "v0.2.0",
        JSON.stringify({ schema: 1, owner: releaseRecordOwner, channel: "stable", version: "0.2.0" }),
        []
      )
    ).toThrow("release intent is invalid");
  });

  it("fails an archive-carrying record whose body is not readable intent", () => {
    expect(() => classifyReleaseRecord("v0.2.0", "not json", [releaseArchiveName])).toThrow(/JSON/);
    expect(() =>
      classifyReleaseRecord("v0.2.0", JSON.stringify({ notes: "human" }), [releaseArchiveName])
    ).toThrow("release intent is invalid");
  });

  it("treats an archive-carrying record with another owner marker as foreign", () => {
    expect(
      classifyReleaseRecord("v0.2.0", JSON.stringify({ schema: 1, owner: "other-release", ...stable }), [
        releaseArchiveName,
      ])
    ).toEqual({ kind: "foreign" });
  });
});
