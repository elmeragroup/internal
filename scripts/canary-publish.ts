import { resolve } from "node:path";

import { validateReceipt } from "./packed-verification.ts";
import { archiveDirectory, archivePath, canaryVersion, packageName, run } from "./release.ts";

const version = canaryVersion();
const archive = validateReceipt(
  {
    reportPath: resolve(archiveDirectory, "archive.json"),
    archivePath: archivePath(version),
    receiptPath: resolve(archiveDirectory, "verified.json"),
    version,
  },
  packageName
);
run("npm", ["publish", archive, "--access", "public", "--tag", "canary", "--ignore-scripts"]);
