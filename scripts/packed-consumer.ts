import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parse } from "yaml";

import { asRecord, asString } from "./lib/json-object.mjs";
import { archiveDirectory, archivePath, releaseVersion, repoRoot, run } from "./release.ts";

const version = releaseVersion();
const catalog = asRecord(
  asRecord(parse(readFileSync(resolve(repoRoot, "pnpm-workspace.yaml"), "utf8")), "workspace").catalog,
  "catalog"
);
const consumer = mkdtempSync(resolve(tmpdir(), "elmera-packed-consumer-"));
rmSync(resolve(archiveDirectory, "verified.json"), { force: true });
try {
  writeFileSync(
    resolve(consumer, "package.json"),
    JSON.stringify(
      {
        name: "canary-consumer",
        packageManager: "pnpm@11.20.0",
        private: true,
        type: "module",
        dependencies: { "@elmeragroup/internal": `file:${archivePath(version)}` },
        devDependencies: {
          oxlint: asString(catalog.oxlint, "oxlint"),
          esbuild: asString(catalog.esbuild, "esbuild"),
        },
      },
      null,
      2
    )
  );
  writeFileSync(resolve(consumer, "pnpm-workspace.yaml"), "autoInstallPeers: false\n");
  cpSync(resolve(repoRoot, "test/packed-consumer.mjs"), resolve(consumer, "check.mjs"));
  cpSync(resolve(repoRoot, "test/packed-consumer"), resolve(consumer, "checks"), { recursive: true });
  run("pnpm", ["install", "--ignore-scripts"], consumer);
  // Node's type stripping is disabled to prove only compiled JavaScript is loaded.
  run(process.execPath, ["--no-experimental-strip-types", "check.mjs"], consumer);
  writeFileSync(
    resolve(archiveDirectory, "verified.json"),
    `${JSON.stringify(
      {
        version,
        archiveReportSha256: createHash("sha256")
          .update(readFileSync(resolve(archiveDirectory, "archive.json")))
          .digest("hex"),
        status: "pass",
      },
      null,
      2
    )}\n`
  );
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
