import { spawnSync } from "node:child_process";

/** Runs a child process with inherited stdio; throws with its exit status on failure. */
export function runCommand(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${String(result.status)}`);
}
