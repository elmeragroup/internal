import type { ReleaseIntent, VerifiedRelease } from "./intent.ts";
import type { Registry } from "./npm.ts";
import {
  compareCanaryVersions,
  compareStableVersions,
  isCanaryReleaseVersion,
  isStableReleaseVersion,
  nextCanaryVersion,
  parseCanaryVersion,
  parseStableVersion,
} from "./version.ts";

export type CommitAncestry = (ancestor: string, descendant: string) => boolean;

export type CanaryEligibility = "eligible" | "canary-superseded" | "stable-superseded";

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

/** Whether a fresh canary may be cut for this commit, or which published release already covers it. */
export function canaryEligibility(
  target: CanaryTarget,
  registry: Registry,
  isAncestor: CommitAncestry
): CanaryEligibility {
  if (compareStableVersions(target.base, target.current) <= 0) {
    throw new Error("The planned version must advance the stable version");
  }
  const history = canaryHistory(target.commit, registry, isAncestor);
  if (history.publishedVersion !== undefined) throw new Error(conflictingCanaryVersion);
  if (history.superseded) return "canary-superseded";
  const highestStable = highestStableVersion(registry);
  // The base advances past the checked-out version, so this one comparison also covers
  // "a stable release already reaches the base" — the test `canaryOwnsChannel` makes when
  // republishing a recorded canary, and the reason `allocateCanary` need not repeat it.
  if (highestStable !== undefined && compareStableVersions(highestStable, target.current) > 0) {
    return "stable-superseded";
  }
  return "eligible";
}

export function allocateCanary(base: string, versions: readonly string[]): string {
  parseStableVersion(base);
  for (const version of versions) {
    if (!isCanaryReleaseVersion(version)) continue;
    const candidate = parseCanaryVersion(version);
    if (compareStableVersions(candidate.base, base) > 0) {
      throw new Error(`Canary base ${base} is older than ${version}`);
    }
  }
  return nextCanaryVersion(base, versions);
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

function canaryOwnsChannel(release: ReleaseIntent, registry: Registry, isAncestor: CommitAncestry): boolean {
  const history = canaryHistory(release.commit, registry, isAncestor);
  if (history.publishedVersion !== undefined && history.publishedVersion !== release.version) {
    throw new Error(conflictingCanaryVersion);
  }
  if (history.superseded) return false;
  // A descendant published stable supersedes this recorded canary even when that stable
  // version is below the canary's planned base. Stables without commit metadata stay on
  // the version comparison below.
  if (descendantStableSupersedes(release.commit, registry, isAncestor)) return false;
  const { base } = parseCanaryVersion(release.version);
  const highestStable = highestStableVersion(registry);
  return highestStable === undefined || compareStableVersions(highestStable, base) < 0;
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
  // Reachable only once canaryOwnsChannel accepted this commit's ancestry, so a tagged canary that
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
  if (!canaryOwnsChannel(release, registry, isAncestor)) {
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
