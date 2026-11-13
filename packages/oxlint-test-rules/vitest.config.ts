import { defineConfig } from "vitest/config";

export default defineConfig({
  // The timeout is a hang guard for the traversal guard, which spawns oxlint; no test is timed.
  test: {
    environment: "node",
    include: ["rules/**/*.test.ts", "shared/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
