import { fileURLToPath } from "node:url";

/** Whether the module at `moduleUrl` is the script Node was asked to run. */
export function isMain(moduleUrl: string): boolean {
  return process.argv[1] === fileURLToPath(moduleUrl);
}

/** Runs `main` when the module is the entry point; import-only uses stay side-effect free. */
export async function runIfMain(moduleUrl: string, main: () => void | Promise<void>): Promise<void> {
  if (isMain(moduleUrl)) await main();
}
