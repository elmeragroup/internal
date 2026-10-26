import { defineConfig } from "tsdown";

import { tsrsLauncherPath } from "../../scripts/tsrs-launcher.ts";

// A config function keeps importing this module free of filesystem reads; tsdown calls it to build.
export default defineConfig(() => ({
  entry: {
    index: "src/index.ts",
    "api-artifacts/model": "src/api-artifacts-model.ts",
    "api-extractor": "src/api-extractor.ts",
    oxlint: "src/oxlint.ts",
    "oxlint/anti-slop": "src/oxlint-anti-slop.ts",
    release: "src/release.ts",
  },
  platform: "node",
  format: "esm",
  target: "node24",
  // tsrs runs the TypeScript 7 declaration emitter; the plugin only infers that generator from a
  // `typescript` 7 install, so it is named here. The public launcher selects the platform binary.
  dts: { generator: "tsgo", tsgo: { path: tsrsLauncherPath(import.meta.dirname) } },
  // TS7 declaration generation uses the config directory as its source root.
  tsconfig: "../../tsconfig.bundle.json",
  banner: { dts: '/// <reference lib="esnext.disposable" />' },
  deps: {
    alwaysBundle: [/^@elmeragroup\//],
    neverBundle: ["effect", "tsrs", "@oxlint/plugins", "undici"],
    onlyImport: ["effect", "tsrs", "@oxlint/plugins", "undici"],
  },
}));
