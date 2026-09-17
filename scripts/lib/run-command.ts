import { spawnSync } from "node:child_process";

/**
 * Runs a child process with inherited stdio; throws with its exit status or
 * terminating signal on failure.
 *
 * @param command - The executable to spawn.
 * @param args - The arguments to pass.
 * @param cwd - The working directory for the child.
 * @throws When the process cannot start, exits non-zero, or is killed by a signal.
 */
export function runCommand(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const reason = result.signal === null ? `status ${String(result.status)}` : `signal ${result.signal}`;
    throw new Error(`${command} failed with ${reason}`);
  }
}
