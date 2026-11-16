import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // A hang guard for suites that spawn the compiler; no test is timed.
    testTimeout: 30_000,
  },
});
