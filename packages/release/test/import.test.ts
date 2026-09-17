import { describe, expect, it } from "vitest";

import { withMissingGitHubCredentials } from "./lib/environment.ts";

describe("engine import-time inertness", () => {
  it("imports operations without GitHub credentials or packing", async () => {
    await withMissingGitHubCredentials(async () => {
      expect(process.env.GH_TOKEN).toBeUndefined();
      const mod = await import("../src/index.ts");
      expect(mod.checkReleasePr).toBeDefined();
      expect(mod.releaseCheckedCommit).toBeDefined();
      expect(mod.retryRelease).toBeDefined();
      expect(mod).not.toHaveProperty("releaseEnvironment");
      expect(mod).not.toHaveProperty("createReleaseOperations");
    });
  });
});
