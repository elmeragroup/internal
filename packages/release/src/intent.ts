export type ReleaseIntent = {
  channel: "canary" | "stable";
  version: string;
  commit: string;
};

export type VerifiedRelease = ReleaseIntent & {
  archive: string;
  integrity: string;
};

export function isCommit(value: string): boolean {
  return /^[a-f0-9]{40}$/.test(value);
}

export function assertCommit(commit: string): string {
  if (!isCommit(commit)) throw new Error(`Expected a full commit SHA; received ${commit}`);
  return commit;
}
