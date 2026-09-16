import type { Brand } from "effect";

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

/** A stable release version in `x.y.z` form; the release channel that owns it is `stable`. */
export type StableVersion = Brand.Branded<string, "StableVersion">;

/** A canary release version in `x.y.z-canary.N` form; the release channel that owns it is `canary`. */
export type CanaryVersion = Brand.Branded<string, "CanaryVersion">;

/** Any release version the pipeline accepts. */
export type ReleaseVersion = StableVersion | CanaryVersion;

/** A canary split into its stable base and its counter. */
export type ParsedCanaryVersion = {
  base: StableVersion;
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

/** Whether `version` is a stable `x.y.z` version; narrows to `StableVersion`. */
export function isStableReleaseVersion(version: string): version is StableVersion {
  return stableComponents(version) !== undefined;
}

/** Whether `version` is a canary `x.y.z-canary.N` version; narrows to `CanaryVersion`. */
export function isCanaryReleaseVersion(version: string): version is CanaryVersion {
  return canaryComponents(version) !== undefined;
}

function isSupportedReleaseVersion(version: string): version is ReleaseVersion {
  return isStableReleaseVersion(version) || isCanaryReleaseVersion(version);
}

/** Parses a stable or canary release version. Throws for any other version form. */
export function assertReleaseVersion(version: string): ReleaseVersion {
  if (!isSupportedReleaseVersion(version)) {
    throw new Error(
      `Unsupported release version ${version}; expected x.y.z or x.y.z-canary.N without leading zeros`
    );
  }
  return version;
}

/** Parses a canary release version. Throws for stable versions and unsupported forms. */
export function assertCanaryReleaseVersion(version: string): CanaryVersion {
  const supported = assertReleaseVersion(version);
  if (!isCanaryReleaseVersion(supported)) {
    throw new Error(`Canary publication requires x.y.z-canary.N; received ${version}`);
  }
  return supported;
}

/** Parses a stable release version. Throws for canary versions and unsupported forms. */
export function assertStableReleaseVersion(version: string): StableVersion {
  if (!isStableReleaseVersion(version)) throw new Error(`Expected a stable version; received ${version}`);
  return version;
}

/** Parses stable components for arithmetic. Throws for any non-stable input. */
export function parseStableVersion(version: string): ParsedStableVersion {
  const components = stableComponents(version);
  if (components === undefined) throw new Error(`Expected a stable version; received ${version}`);
  const [major, minor, patch] = components;
  return { major: BigInt(major), minor: BigInt(minor), patch: BigInt(patch) };
}

/** Parses a canary into its stable base and counter. Throws for any non-canary input. */
export function parseCanaryVersion(version: string): ParsedCanaryVersion {
  const components = canaryComponents(version);
  if (components === undefined) {
    throw new Error(`Canary publication requires x.y.z-canary.N; received ${version}`);
  }
  return { base: assertStableReleaseVersion(components.base), n: BigInt(components.suffix) };
}

function formatStableVersion(version: ParsedStableVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/** Renders parsed canary components as the recorded `x.y.z-canary.N` string. */
export function formatCanaryVersion(version: ParsedCanaryVersion): CanaryVersion {
  return assertCanaryReleaseVersion(`${version.base}-canary.${version.n}`);
}

function compareParsedStableVersions(left: ParsedStableVersion, right: ParsedStableVersion): number {
  if (left.major !== right.major) return left.major > right.major ? 1 : -1;
  if (left.minor !== right.minor) return left.minor > right.minor ? 1 : -1;
  if (left.patch !== right.patch) return left.patch > right.patch ? 1 : -1;
  return 0;
}

/** Compares two parsed stable versions numerically. */
export function compareStableVersions(left: StableVersion, right: StableVersion): number {
  return compareParsedStableVersions(parseStableVersion(left), parseStableVersion(right));
}

/** The next patch after `version`, keeping the major and minor components. */
export function nextPatchVersion(version: string): StableVersion {
  const parsed = parseStableVersion(version);
  return assertStableReleaseVersion(formatStableVersion({ ...parsed, patch: parsed.patch + 1n }));
}

/** Compares two parsed canaries by base first, then by counter. */
export function compareCanaryVersions(left: CanaryVersion, right: CanaryVersion): number {
  const parsedLeft = parseCanaryVersion(left);
  const parsedRight = parseCanaryVersion(right);
  const baseOrder = compareStableVersions(parsedLeft.base, parsedRight.base);
  if (baseOrder !== 0) return baseOrder;
  return parsedLeft.n === parsedRight.n ? 0 : parsedLeft.n > parsedRight.n ? 1 : -1;
}
