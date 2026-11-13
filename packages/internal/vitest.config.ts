import { defineConfig } from "vitest/config";

export default defineConfig({
  // The timeout is a hang guard for suites that spawn the compiler; no test is timed.
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
