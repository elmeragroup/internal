import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "api-artifacts/model": "src/api-artifacts-model.ts",
    "api-extractor": "src/api-extractor.ts",
    oxlint: "src/oxlint.ts",
    "oxlint/anti-slop": "src/oxlint-anti-slop.ts",
    "oxlint/tests": "src/oxlint-tests.ts",
    release: "src/release.ts",
  },
  platform: "node",
  format: "esm",
  target: "node24",
  // tsrs runs the TypeScript 7 declaration emitter through its own API. The plugin never selects
  // this generator automatically, so it is named here.
  dts: { generator: "tsrs" },
  // TS7 declaration generation uses the config directory as its source root.
  tsconfig: "../../tsconfig.bundle.json",
  banner: { dts: '/// <reference lib="esnext.disposable" />' },
  deps: {
    alwaysBundle: [/^@elmeragroup\//],
    neverBundle: ["effect", "tsrs", "@oxlint/plugins", "undici"],
    onlyImport: ["effect", "tsrs", "@oxlint/plugins", "undici"],
  },
});
