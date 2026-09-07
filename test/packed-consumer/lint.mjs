import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const root = process.cwd();
await writeFile(
  "reject-compiler.mjs",
  `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (/^(?:effect|typescript)(?:\\/|$)/.test(specifier)) throw new Error("Unexpected runtime import: " + specifier);
  return nextResolve(specifier, context);
}});
`
);
await writeFile(
  "check-entries.mjs",
  `import assert from "node:assert/strict";
const model = await import("@elmeragroup/internal/api-artifacts/model");
assert.deepEqual(Object.keys(model), []);
const { default: elmera } = await import("@elmeragroup/internal/oxlint");
const { default: antiSlop } = await import("@elmeragroup/internal/oxlint/anti-slop");
assert.ok(elmera.rules["no-tailwind-dark-variant"]);
assert.ok(antiSlop.rules["no-reflect-get"]);
`
);
execFileSync(
  process.execPath,
  ["--no-experimental-strip-types", "--import", "./reject-compiler.mjs", "check-entries.mjs"],
  { stdio: "inherit" }
);
await writeFile(
  ".oxlintrc.json",
  JSON.stringify({
    jsPlugins: [
      { name: "elmera", specifier: "@elmeragroup/internal/oxlint" },
      { name: "anti-slop", specifier: "@elmeragroup/internal/oxlint/anti-slop" },
    ],
    rules: { "elmera/no-tailwind-dark-variant": "error", "anti-slop/no-reflect-get": "error" },
  })
);
await writeFile(
  "lint-input.ts",
  'export const classes = "dark:bg-red-500";\nexport const value = Reflect.get({}, "key");\n'
);
const oxlint = path.join(path.dirname(require.resolve("oxlint/package.json")), "bin/oxlint");
const lint = spawnSync(oxlint, ["--config", ".oxlintrc.json", "lint-input.ts"], {
  encoding: "utf8",
  env: {
    ...process.env,
    NODE_OPTIONS: `--no-experimental-strip-types --import=${path.join(root, "reject-compiler.mjs")}`,
  },
});
assert.equal(lint.status, 1, lint.stdout + lint.stderr);
assert.match(lint.stdout + lint.stderr, /no-tailwind-dark-variant/);
assert.match(lint.stdout + lint.stderr, /no-reflect-get/);
assert.doesNotMatch(lint.stdout + lint.stderr, /Unexpected runtime import/);
