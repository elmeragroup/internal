export type ReleaseCommand = { mode: "main"; commit: string } | { mode: "retry"; tag: string };

const usage = "Usage: pnpm release:run main <commit> | retry <record-tag>";

export function parseReleaseCommand(argv: readonly string[]): ReleaseCommand {
  const [mode, target] = argv;
  if (mode === undefined || target === undefined) throw new Error(usage);
  if (mode === "main") return { mode: "main", commit: target };
  if (mode === "retry") return { mode: "retry", tag: target };
  throw new Error(usage);
}
