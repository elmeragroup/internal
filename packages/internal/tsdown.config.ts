import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "api-artifacts/model": "src/api-artifacts-model.ts",
    "api-extractor": "src/api-extractor.ts",
    oxlint: "src/oxlint.ts",
    "oxlint/anti-slop": "src/oxlint-anti-slop.ts",
  },
  platform: "node",
  format: "esm",
  target: "node24",
  dts: true,
  // TS7 declaration generation uses the config directory as its source root.
  tsconfig: "../../tsconfig.bundle.json",
  banner: { dts: '/// <reference lib="esnext.disposable" />' },
  deps: {
    alwaysBundle: [/^@elmeragroup\//],
    neverBundle: ["effect", "typescript", "@oxlint/plugins"],
    onlyImport: ["effect", "typescript", "@oxlint/plugins"],
  },
});
