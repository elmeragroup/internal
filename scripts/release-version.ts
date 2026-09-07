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
