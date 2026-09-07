import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { archiveDirectory, archivePath, packageNames, releaseVersion, repoRoot, run } from "./release.ts";

const version = releaseVersion();
const consumer = mkdtempSync(resolve(tmpdir(), "elmera-packed-consumer-"));
rmSync(resolve(archiveDirectory, "verified.json"), { force: true });
try {
  const overrides = Object.fromEntries(
    packageNames.map((name) => [`@elmeragroup/${name}`, `file:${archivePath(name, version)}`])
  );
  writeFileSync(
    resolve(consumer, "package.json"),
    JSON.stringify(
      {
        name: "canary-consumer",
        packageManager: "pnpm@11.20.0",
        private: true,
        type: "module",
        dependencies: { "@elmeragroup/internal": `file:${archivePath("internal", version)}` },
      },
      null,
      2
    )
  );
  writeFileSync(
    resolve(consumer, "pnpm-workspace.yaml"),
    `overrides: ${JSON.stringify(overrides)}\nautoInstallPeers: false\n`
  );
  cpSync(resolve(repoRoot, "test/packed-consumer.mjs"), resolve(consumer, "check.mjs"));
  run("pnpm", ["install", "--ignore-scripts"], consumer);
  // Node's type stripping is disabled to prove only compiled JavaScript is loaded.
  run(process.execPath, ["--no-experimental-strip-types", "check.mjs"], consumer);
  writeFileSync(
    resolve(archiveDirectory, "verified.json"),
    `${JSON.stringify(
      {
        version,
        archivesSha256: createHash("sha256")
          .update(readFileSync(resolve(archiveDirectory, "archives.json")))
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
