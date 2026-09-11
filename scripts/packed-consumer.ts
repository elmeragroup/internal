import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parse } from "yaml";

import { asRecord, asString } from "./lib/json-object.mjs";
import { runCommand } from "./lib/run-command.ts";
import { verifyPackedArchive } from "./packed-verification.ts";
import { archivePath, packageName, releaseVersion, repoRoot } from "./release.ts";

const version = releaseVersion();
const catalog = asRecord(
  asRecord(parse(readFileSync(resolve(repoRoot, "pnpm-workspace.yaml"), "utf8")), "workspace").catalog,
  "catalog"
);
const consumer = mkdtempSync(resolve(tmpdir(), "elmera-packed-consumer-"));
try {
  verifyPackedArchive(archivePath(version), packageName, (snapshotArchivePath) => {
    writeFileSync(
      resolve(consumer, "package.json"),
      JSON.stringify(
        {
          name: "canary-consumer",
          packageManager: "pnpm@11.20.0",
          private: true,
          type: "module",
          dependencies: { "@elmeragroup/internal": `file:${snapshotArchivePath}` },
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
    cpSync(resolve(repoRoot, "test/packed-consumer"), resolve(consumer, "checks"), { recursive: true });
    runCommand("pnpm", ["install", "--ignore-scripts"], consumer);
    // Node's type stripping is disabled to prove only compiled JavaScript is loaded.
    for (const check of ["api", "types", "lint", "tree-shaking", "release"]) {
      runCommand(process.execPath, ["--no-experimental-strip-types", `checks/${check}.mjs`], consumer);
    }
  });
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
