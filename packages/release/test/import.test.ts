import { describe, expect, it } from "vitest";

describe("engine import-time inertness", () => {
  it("imports operations without GitHub credentials or packing", async () => {
    const missing = { GITHUB_REPOSITORY: undefined, GH_TOKEN: undefined };
    const previous = {
      GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
      GH_TOKEN: process.env.GH_TOKEN,
    };
    Object.assign(process.env, missing);
    try {
      const mod = await import("../src/index.ts");
      expect(mod.checkReleasePr).toBeDefined();
      expect(mod.releaseCheckedCommit).toBeDefined();
      expect(mod.retryRelease).toBeDefined();
    } finally {
      if (previous.GITHUB_REPOSITORY === undefined) delete process.env.GITHUB_REPOSITORY;
      else process.env.GITHUB_REPOSITORY = previous.GITHUB_REPOSITORY;
      if (previous.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previous.GH_TOKEN;
    }
  });
});
