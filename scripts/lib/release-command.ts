export type ReleaseCommand = { mode: "main"; commit: string } | { mode: "retry"; tag: string };

const usage = "Usage: pnpm release:run main <commit> | retry <record-tag>";

/**
 * Parses the publish-release command line.
 *
 * @param argv - Arguments after the script name; exactly `<mode> <target>`.
 * @returns The parsed command.
 * @throws When the mode, target, or argument count is not exactly one of the documented forms.
 */
export function parseReleaseCommand(argv: readonly string[]): ReleaseCommand {
  if (argv.length !== 2) throw new Error(usage);
  const [mode, target] = argv;
  if (mode === undefined || target === undefined) throw new Error(usage);
  if (mode === "main") return { mode: "main", commit: target };
  if (mode === "retry") return { mode: "retry", tag: target };
  throw new Error(usage);
}
