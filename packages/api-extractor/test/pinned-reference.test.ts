import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { failedFixtureIndices } from "../scripts/conformance/report.ts";
import { conformanceFixtureManifest } from "../scripts/fixture-evidence.ts";
import {
  pinnedFixturePathUniverse,
  pinnedUpstream,
  referenceAvailable,
  upstreamFixtureRoot,
  auditPinnedReference,
  validatePinnedFixturePathUniverse,
} from "../scripts/reference.ts";
import { createTemporaryRoot, fixtureRoot } from "./support/temp-dirs.ts";

describe("Issue 14 pinned reference", () => {
  it("keeps copied input and output.json bytes equal to the optional pinned reference", () => {
    if (!referenceAvailable) return;
    for (const definition of conformanceFixtureManifest) {
      for (const file of [definition.file, "output.json"]) {
        expect(readFileSync(resolve(fixtureRoot, definition.fixture, file))).toEqual(
          readFileSync(resolve(upstreamFixtureRoot, definition.fixture, file))
        );
      }
    }
  });
  it("supports an optional skipped audit and a required unavailable audit without filesystem mutation", () => {
    const missingRoot = resolve(fixtureRoot, "__missing-pinned-reference__");
    expect(auditPinnedReference("optional", { referenceRoot: missingRoot }).status).toBe("skipped");
    expect(() => auditPinnedReference("required", { referenceRoot: missingRoot })).toThrow(
      /reference is unavailable/u
    );
  });

  it("recursively verifies every copied upstream fixture/support file when available", () => {
    const audit = auditPinnedReference("optional");
    if (audit.status === "skipped") return;
    expect(audit.fixtureCount).toBe(116);
    expect(audit.comparedFiles).toBe(251);
  });

  it("rejects a mutation in a recursively copied upstream support file", () => {
    if (!referenceAvailable) return;
    const temporaryRoot = createTemporaryRoot("api-extractor-reference-audit-");
    const temporaryFixtures = join(temporaryRoot, "fixtures");
    try {
      cpSync(fixtureRoot, temporaryFixtures, { recursive: true });
      const target = join(temporaryFixtures, "class-members-visibility-and-signatures", "input.ts");
      writeFileSync(target, readFileSync(target, "utf8") + "\n// recursive audit mutation\n");
      expect(() => auditPinnedReference("required", { fixtureRoot: temporaryFixtures })).toThrow(
        /bytes changed/u
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects an unversioned fixture tree instead of accepting its claimed identity", () => {
    if (!referenceAvailable) return;
    const temporaryRoot = createTemporaryRoot("api-extractor-unversioned-reference-");
    try {
      cpSync(upstreamFixtureRoot, join(temporaryRoot, "test/fixtures"), { recursive: true });
      expect(() => auditPinnedReference("required", { referenceRoot: temporaryRoot })).toThrow(
        /git|checkout|identity/u
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects a dirty checkout before it can redefine the pinned evidence", () => {
    if (!referenceAvailable) return;
    const temporaryRoot = createTemporaryRoot("api-extractor-dirty-reference-");
    const temporaryReference = join(temporaryRoot, "checkout");
    try {
      cpSync(pinnedUpstream.root, temporaryReference, { recursive: true });
      const target = join(
        temporaryReference,
        "test/fixtures",
        "class-members-visibility-and-signatures",
        "input.ts"
      );
      writeFileSync(target, readFileSync(target, "utf8") + "\n// dirty checkout mutation\n");
      expect(() => auditPinnedReference("required", { referenceRoot: temporaryReference })).toThrow(/dirty/u);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("pins the exact recursive path universe rather than trusting a supplied count", () => {
    expect(pinnedFixturePathUniverse.count).toBe(251);
    expect(() => validatePinnedFixturePathUniverse(["fake/input.ts"])).toThrow(/path universe/u);
  });

  it("counts distinct typecheck and extraction failures as one union", () => {
    expect(
      failedFixtureIndices(
        [{ status: "failed" }, { status: "pass" }],
        [{ status: "match" }, { status: "failed" }]
      )
    ).toEqual([0, 1]);
  });
});
