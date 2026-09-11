import type { ReleaseIntent, VerifiedRelease } from "./intent.ts";
import type { Registry } from "./npm.ts";
import {
  compareCanaryVersions,
  compareStableVersions,
  formatCanaryVersion,
  isCanaryReleaseVersion,
  isStableReleaseVersion,
  parseCanaryVersion,
  parseStableVersion,
} from "./version.ts";

export type CommitAncestry = (ancestor: string, descendant: string) => boolean;

/** Whether a commit still owns its canary channel, or which published release already covers it. */
export type CanarySupersession = "owned" | "canary-superseded" | "stable-superseded";

export type PublicationPlan = { kind: "superseded" } | { kind: "publish"; upload: boolean; promote: boolean };

const conflictingCanaryVersion =
  "Commit already has a different canary version or its durable release record is missing";

export function distTagFor(channel: ReleaseIntent["channel"]): "canary" | "latest" {
  return channel === "stable" ? "latest" : "canary";
}

function highestStableVersion(registry: Registry): string | undefined {
  let highest: string | undefined;
  for (const version of registry.versions.keys()) {
    if (!isStableReleaseVersion(version)) continue;
    if (highest === undefined || compareStableVersions(version, highest) > 0) highest = version;
  }
  return highest;
}

function publishedCanaryCommits(registry: Registry): { version: string; commit: string }[] {
  const canaries: { version: string; commit: string }[] = [];
  for (const [version, published] of registry.versions) {
    if (isCanaryReleaseVersion(version) && published.commit !== undefined) {
      canaries.push({ version, commit: published.commit });
    }
  }
  return canaries;
}

type CanaryHistory = {
  publishedVersion: string | undefined;
  superseded: boolean;
};

function canaryHistory(commit: string, registry: Registry, isAncestor: CommitAncestry): CanaryHistory {
  const versionsForCommit: string[] = [];
  let diverged = false;
  let descendant = false;
  for (const published of publishedCanaryCommits(registry)) {
    if (published.commit === commit) {
      versionsForCommit.push(published.version);
      continue;
    }
    if (isAncestor(commit, published.commit)) {
      descendant = true;
      continue;
    }
    if (!isAncestor(published.commit, commit)) diverged = true;
  }
  if (versionsForCommit.length > 1) throw new Error(conflictingCanaryVersion);
  if (diverged) throw new Error("Published canary history diverged from main");
  return { publishedVersion: versionsForCommit[0], superseded: descendant };
}

/** The canary a main commit would cut: its source commit, the checked-out line, and the planned base. */
export type CanaryTarget = {
  commit: string;
  current: string;
  base: string;
};

/**
 * Whether `commit` still owns the canary channel at `base`. Ancestry covers published canaries and
 * published stables from descendant commits; the base comparison covers stables at or above the base.
 * Callers pass the version of their durable record so a published canary for the same commit and
 * version is owned rather than a conflict.
 */
export function canarySupersession(
  commit: string,
  base: string,
  registry: Registry,
  isAncestor: CommitAncestry,
  recordedVersion?: string
): CanarySupersession {
  const history = canaryHistory(commit, registry, isAncestor);
  if (history.publishedVersion !== undefined && history.publishedVersion !== recordedVersion) {
    throw new Error(conflictingCanaryVersion);
  }
  if (history.superseded) return "canary-superseded";
  if (descendantStableSupersedes(commit, registry, isAncestor)) return "stable-superseded";
  const highestStable = highestStableVersion(registry);
  if (highestStable !== undefined && compareStableVersions(highestStable, base) >= 0) {
    return "stable-superseded";
  }
  return "owned";
}

/** Whether a fresh canary may be cut for this commit, or which published release already covers it. */
export function canaryEligibility(
  target: CanaryTarget,
  registry: Registry,
  isAncestor: CommitAncestry
): CanarySupersession {
  if (compareStableVersions(target.base, target.current) <= 0) {
    throw new Error("The planned version must advance the stable version");
  }
  return canarySupersession(target.commit, target.base, registry, isAncestor);
}

/**
 * Allocates the next canary number for `base`, or reports `undefined` when a published or reserved
 * canary already belongs to a newer base. A regressed base skips; it never blocks publication.
 */
export function allocateCanary(base: string, versions: readonly string[]): string | undefined {
  parseStableVersion(base);
  let highest = -1n;
  for (const version of versions) {
    if (!isCanaryReleaseVersion(version)) continue;
    const candidate = parseCanaryVersion(version);
    if (compareStableVersions(candidate.base, base) > 0) return undefined;
    if (candidate.base === base && candidate.n > highest) highest = candidate.n;
  }
  return formatCanaryVersion({ base, n: highest + 1n });
}

/** Whether npm already carries this exact archive; a same-version mismatch is fatal. */
export function npmIdentity(release: VerifiedRelease, registry: Registry): "absent" | "match" {
  const existing = registry.versions.get(release.version);
  if (existing === undefined) return "absent";
  if (existing.integrity === undefined) {
    throw new Error(`npm ${release.version} is missing dist integrity`);
  }
  if (existing.integrity !== release.integrity || existing.commit !== release.commit) {
    throw new Error(`npm ${release.version} does not match the recorded archive and commit`);
  }
  return "match";
}

function descendantStableSupersedes(commit: string, registry: Registry, isAncestor: CommitAncestry): boolean {
  for (const [version, published] of registry.versions) {
    if (!isStableReleaseVersion(version) || published.commit === undefined) continue;
    if (isAncestor(commit, published.commit)) return true;
  }
  return false;
}

function stableTakesLatest(release: ReleaseIntent, registry: Registry): boolean {
  const current = registry.tags.get(distTagFor(release.channel));
  if (current === undefined) return true;
  if (current === release.version) return false;
  if (!isStableReleaseVersion(current)) {
    return compareStableVersions(release.version, parseCanaryVersion(current).base) >= 0;
  }
  return compareStableVersions(release.version, current) > 0;
}

function canaryTakesTag(release: ReleaseIntent, registry: Registry): boolean {
  const current = registry.tags.get(distTagFor(release.channel));
  if (current === undefined) return true;
  if (current === release.version) return false;
  // Reachable only once canarySupersession accepted this commit's ancestry, so a tagged canary that
  // records its source commit is behind us. Versions predating that metadata fall back to suffix order.
  if (registry.versions.get(current)?.commit !== undefined) return true;
  return compareCanaryVersions(release.version, current) > 0;
}

export function planPublication(
  release: VerifiedRelease,
  registry: Registry,
  isAncestor: CommitAncestry
): PublicationPlan {
  const published = npmIdentity(release, registry) === "match";
  if (release.channel === "stable") {
    return { kind: "publish", upload: !published, promote: stableTakesLatest(release, registry) };
  }
  const ownsChannel =
    canarySupersession(
      release.commit,
      parseCanaryVersion(release.version).base,
      registry,
      isAncestor,
      release.version
    ) === "owned";
  if (!ownsChannel) {
    return published ? { kind: "publish", upload: false, promote: false } : { kind: "superseded" };
  }
  return { kind: "publish", upload: !published, promote: canaryTakesTag(release, registry) };
}

/** Promotion is re-decided against the registry read that confirmed the upload. */
export function shouldPromote(
  release: VerifiedRelease,
  registry: Registry,
  isAncestor: CommitAncestry
): boolean {
  const plan = planPublication(release, registry, isAncestor);
  return plan.kind === "publish" && plan.promote;
}
