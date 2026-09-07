import { execFileSync } from "node:child_process";

for (const check of ["api", "types", "lint", "tree-shaking"]) {
  execFileSync(process.execPath, ["--no-experimental-strip-types", `checks/${check}.mjs`], {
    stdio: "inherit",
  });
}
