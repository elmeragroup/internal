import type { Plugin } from "@oxlint/plugins";

import { noClassAssertions } from "./rules/no-class-assertions.ts";
import { noFixedDelay } from "./rules/no-fixed-delay.ts";
import { noGeometryAssertions } from "./rules/no-geometry-assertions.ts";
import { noSourceReadingTests } from "./rules/no-source-reading-tests.ts";
import { noTestRetry } from "./rules/no-test-retry.ts";
import { noWallClock } from "./rules/no-wall-clock.ts";

/**
 * Test-shape rules: the mechanical shapes a test may not take because they flake or pin the
 * implementation. A config scopes them to test files through its overrides.
 */
const testsPlugin: Plugin = {
  meta: { name: "tests" },
  rules: {
    "no-class-assertions": noClassAssertions,
    "no-fixed-delay": noFixedDelay,
    "no-geometry-assertions": noGeometryAssertions,
    "no-source-reading-tests": noSourceReadingTests,
    "no-test-retry": noTestRetry,
    "no-wall-clock": noWallClock,
  },
};

export default testsPlugin;
