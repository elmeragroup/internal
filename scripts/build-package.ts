import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

import { tsrsLauncherPath } from "./tsrs-launcher.ts";

const packageDirectory = process.cwd();
rmSync(resolve(packageDirectory, "dist"), { recursive: true, force: true });
execFileSync(process.execPath, [tsrsLauncherPath(packageDirectory), "-p", "tsconfig.build.json"], {
  cwd: packageDirectory,
  stdio: "inherit",
});
