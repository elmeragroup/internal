const numericIdentifier = /^(?:0|[1-9]\d*)$/;
const canaryMarker = "-canary.";

/**
 * Components stay `bigint`: these versions come from the npm registry, the grammar accepts
 * unbounded digits, and a canary counter beyond `Number.MAX_SAFE_INTEGER` must not round.
 */
export type ParsedStableVersion = {
  major: bigint;
  minor: bigint;
  patch: bigint;
};

export type ParsedCanaryVersion = {
  base: string;
  n: bigint;
};

function isNumericIdentifier(value: string): boolean {
  return numericIdentifier.test(value);
}

function stableComponents(version: string): readonly [string, string, string] | undefined {
  const [major, minor, patch, ...rest] = version.split(".");
  if (major === undefined || minor === undefined || patch === undefined || rest.length !== 0) {
    return undefined;
  }
  if (!isNumericIdentifier(major) || !isNumericIdentifier(minor) || !isNumericIdentifier(patch)) {
    return undefined;
  }
  return [major, minor, patch];
}

function canaryComponents(version: string): { base: string; suffix: string } | undefined {
  const marker = version.indexOf(canaryMarker);
  if (marker === -1) return undefined;
  const base = version.slice(0, marker);
  const suffix = version.slice(marker + canaryMarker.length);
  if (stableComponents(base) === undefined || !isNumericIdentifier(suffix)) return undefined;
  return { base, suffix };
}

export function isStableReleaseVersion(version: string): boolean {
  return stableComponents(version) !== undefined;
}

export function isCanaryReleaseVersion(version: string): boolean {
  return canaryComponents(version) !== undefined;
}

function isSupportedReleaseVersion(version: string): boolean {
  return isStableReleaseVersion(version) || isCanaryReleaseVersion(version);
}

export function assertReleaseVersion(version: string): string {
  if (!isSupportedReleaseVersion(version)) {
    throw new Error(
      `Unsupported release version ${version}; expected x.y.z or x.y.z-canary.N without leading zeros`
    );
  }
  return version;
}

export function assertCanaryReleaseVersion(version: string): string {
  assertReleaseVersion(version);
  if (!isCanaryReleaseVersion(version)) {
    throw new Error(`Canary publication requires x.y.z-canary.N; received ${version}`);
  }
  return version;
}

export function assertStableReleaseVersion(version: string): string {
  if (!isStableReleaseVersion(version)) throw new Error(`Expected a stable version; received ${version}`);
  return version;
}

export function parseStableVersion(version: string): ParsedStableVersion {
  const components = stableComponents(version);
  if (components === undefined) throw new Error(`Expected a stable version; received ${version}`);
  const [major, minor, patch] = components;
  return { major: BigInt(major), minor: BigInt(minor), patch: BigInt(patch) };
}

export function parseCanaryVersion(version: string): ParsedCanaryVersion {
  const components = canaryComponents(version);
  if (components === undefined) {
    throw new Error(`Canary publication requires x.y.z-canary.N; received ${version}`);
  }
  return { base: components.base, n: BigInt(components.suffix) };
}

function formatStableVersion(version: ParsedStableVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function formatCanaryVersion(version: ParsedCanaryVersion): string {
  return `${version.base}-canary.${version.n}`;
}

function compareParsedStableVersions(left: ParsedStableVersion, right: ParsedStableVersion): number {
  if (left.major !== right.major) return left.major > right.major ? 1 : -1;
  if (left.minor !== right.minor) return left.minor > right.minor ? 1 : -1;
  if (left.patch !== right.patch) return left.patch > right.patch ? 1 : -1;
  return 0;
}

export function compareStableVersions(left: string, right: string): number {
  return compareParsedStableVersions(parseStableVersion(left), parseStableVersion(right));
}

export function nextPatchVersion(version: string): string {
  const parsed = parseStableVersion(version);
  return formatStableVersion({ ...parsed, patch: parsed.patch + 1n });
}

export function compareCanaryVersions(left: string, right: string): number {
  const parsedLeft = parseCanaryVersion(left);
  const parsedRight = parseCanaryVersion(right);
  const baseOrder = compareStableVersions(parsedLeft.base, parsedRight.base);
  if (baseOrder !== 0) return baseOrder;
  return parsedLeft.n === parsedRight.n ? 0 : parsedLeft.n > parsedRight.n ? 1 : -1;
}

export function nextCanaryVersion(base: string, published: readonly string[]): string {
  parseStableVersion(base);
  let highest = -1n;
  for (const version of published) {
    if (!isCanaryReleaseVersion(version)) continue;
    const candidate = parseCanaryVersion(version);
    if (candidate.base !== base) continue;
    if (candidate.n > highest) highest = candidate.n;
  }
  return formatCanaryVersion({ base, n: highest + 1n });
}
