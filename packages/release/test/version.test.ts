import { describe, expect, it } from "vitest";

import {
  assertCanaryReleaseVersion,
  assertReleaseVersion,
  compareCanaryVersions,
  nextPatchVersion,
  parseCanaryVersion,
  parseStableVersion,
} from "../src/version.ts";

describe("release versions", () => {
  it.each(["0.1.0", "1.2.3", "0.1.0-canary.1"])("accepts %s", (version) => {
    expect(assertReleaseVersion(version)).toBe(version);
  });
  it.each([
    "",
    "1.0",
    "v1.0.0",
    "1.0.0-canary",
    "1.0.0-beta.1",
    "1.0.0+build.1",
    "1.0.0-canary.1+meta",
    "01.0.0",
    "1.01.0",
    "1.0.01",
    "1.0.0-canary.01",
  ])("rejects %s", (version) => {
    expect(() => assertReleaseVersion(version)).toThrow(/Unsupported release version/);
  });
});
describe("canary publication versions", () => {
  it("accepts a canary", () => expect(assertCanaryReleaseVersion("0.1.0-canary.2")).toBe("0.1.0-canary.2"));
  it("rejects a stable version", () =>
    expect(() => assertCanaryReleaseVersion("0.1.0")).toThrow(/Canary publication requires/));
});

describe("parsed release versions", () => {
  it("parses a stable version once for arithmetic", () => {
    expect(parseStableVersion("1.2.3")).toEqual({ major: 1n, minor: 2n, patch: 3n });
  });
  it("parses a canary as a stable base plus suffix", () => {
    expect(parseCanaryVersion("0.2.0-canary.11")).toEqual({ base: "0.2.0", n: 11n });
  });
  it("compares large canary counters without rounding", () => {
    expect(compareCanaryVersions("1.0.0-canary.10", "1.0.0-canary.9")).toBe(1);
  });
  it("starts a new patch base from the previous stable", () => {
    expect(nextPatchVersion("0.2.9")).toBe("0.2.10");
  });
});
