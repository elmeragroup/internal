const numericIdentifier = "(?:0|[1-9]\\d*)";
const stableReleaseVersion = new RegExp(
  `^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}$`
);
const canaryReleaseVersion = new RegExp(
  `^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}-canary\\.${numericIdentifier}$`
);

function isStableReleaseVersion(version: string): boolean {
  return stableReleaseVersion.test(version);
}

function isCanaryReleaseVersion(version: string): boolean {
  return canaryReleaseVersion.test(version);
}

function isSupportedReleaseVersion(version: string): boolean {
  return isStableReleaseVersion(version) || isCanaryReleaseVersion(version);
}

export function assertCoordinatedReleaseVersion(versions: readonly string[]): string {
  const first = versions[0];
  if (first === undefined) {
    throw new Error("Release packages must include at least one version");
  }
  if (versions.some((version) => version !== first)) {
    throw new Error(`All release packages must have the same version; received ${versions.join(", ")}`);
  }
  if (!isSupportedReleaseVersion(first)) {
    throw new Error(
      `Unsupported release version ${first}; expected x.y.z or x.y.z-canary.N without leading zeros`
    );
  }
  return first;
}

export function assertCanaryReleaseVersion(versions: readonly string[]): string {
  const version = assertCoordinatedReleaseVersion(versions);
  if (!isCanaryReleaseVersion(version)) {
    throw new Error(`Canary publication requires x.y.z-canary.N; received ${version}`);
  }
  return version;
}
