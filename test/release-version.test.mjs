import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { archivePath } from "../scripts/release.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("archive names", () => {
  it("keeps the canary archive filename", () => {
    expect(archivePath("0.1.0-canary.0")).toBe(
      join(repoRoot, ".artifacts/release", "elmeragroup-internal-0.1.0-canary.0.tgz")
    );
  });

  it("names stable archives with the same pattern", () => {
    expect(archivePath("0.1.0")).toBe(join(repoRoot, ".artifacts/release", "elmeragroup-internal-0.1.0.tgz"));
  });
});
