import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const packageDirectory = process.cwd();
rmSync(resolve(packageDirectory, "dist"), { recursive: true, force: true });
execFileSync(
  process.execPath,
  [resolve(packageDirectory, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
  { cwd: packageDirectory, stdio: "inherit" }
);
