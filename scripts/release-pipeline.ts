import { setTimeout } from "node:timers/promises";

import { withArchiveWorkshop } from "./release-archive.ts";
import type { ArchiveWorkshop } from "./release-archive.ts";
import { createStableReleaseGate } from "./release-gate.ts";
import type { StableReleaseGate } from "./release-gate.ts";
import { createGitPort } from "./release-git.ts";
import type { GitPort } from "./release-git.ts";
import { createGitHubClient } from "./release-github-client.ts";
import { createReleaseStore } from "./release-github.ts";
import type { ReleaseStore, SavedRelease } from "./release-github.ts";
import { plannedCanaryBase } from "./release-plan.ts";
import { allocateCanary, canaryEligibility } from "./release-policy.ts";
import type { CanaryEligibility } from "./release-policy.ts";
import { publishVerifiedRelease } from "./release-publication.ts";
import { assertCommit, assertReleaseTag, releaseTag } from "./release-record.ts";
import type { ReleaseIntent, VerifiedRelease } from "./release-record.ts";
import { readRegistry } from "./release-registry.ts";
import type { Registry } from "./release-registry.ts";
import { packageName, run } from "./release.ts";

export type ReleaseServices = {
  git: GitPort;
  store: ReleaseStore;
  registry: () => Promise<Registry>;
  archive: ArchiveWorkshop;
  stableGate: StableReleaseGate;
  plannedCanaryBase: (current: string) => string;
  publishVerified: (release: VerifiedRelease) => Promise<"published" | "superseded">;
  log: (message: string) => void;
};

export type ReleaseCommand = { mode: "main"; commit: string } | { mode: "retry"; tag: string };

async function recordRelease(intent: ReleaseIntent, services: ReleaseServices): Promise<SavedRelease> {
  const saved = await services.store.create(intent);
  if (saved.asset.state === "uploaded") return saved;
  return await services.store.upload(saved, services.archive.pack(intent));
}

async function finishRelease(saved: SavedRelease, services: ReleaseServices): Promise<void> {
  const release = services.archive.restore(saved.intent, await services.store.download(saved));
  const result = await services.publishVerified(release);
  if (result === "superseded") {
    services.log(`Skipping superseded canary ${saved.intent.version}; its draft record remains reserved`);
    return;
  }
  await services.store.complete(saved);
  services.log(
    `Released ${packageName}@${saved.intent.version} from ${saved.intent.commit}. Record: ${releaseTag(saved.intent)}`
  );
}

function skipReason(eligibility: Exclude<CanaryEligibility, "eligible">): string {
  return eligibility === "canary-superseded"
    ? "Skipping a commit superseded by a published canary"
    : "Skipping a commit superseded by a stable release";
}

async function mainReleaseIntent(
  commit: string,
  services: ReleaseServices
): Promise<ReleaseIntent | undefined> {
  const line = await services.stableGate(commit, services.git.stableVersionAt(`${commit}^1`));
  if (line.channel === "stable") return { channel: "stable", version: line.version, commit };
  const recorded = await services.store.find(`canary-${commit}`);
  if (recorded !== undefined) return recorded.intent;
  const base = services.plannedCanaryBase(line.current);
  const registry = await services.registry();
  const target = { commit, current: line.current, base };
  const eligibility = canaryEligibility(target, registry, services.git.isAncestor);
  if (eligibility !== "eligible") {
    services.log(skipReason(eligibility));
    return undefined;
  }
  const reserved = await services.store.reservedCanaryVersions();
  const version = allocateCanary(base, [...registry.versions.keys(), ...reserved]);
  return { channel: "canary", version, commit };
}

async function releaseMain(commit: string, services: ReleaseServices): Promise<void> {
  if (services.git.head() !== commit) throw new Error("Checkout differs from the checked commit");
  if (!services.git.isAncestor(commit, services.git.originMain()))
    throw new Error("Release source is not on main");
  if (!services.git.isClean()) throw new Error("Release requires a clean checkout");
  const intent = await mainReleaseIntent(commit, services);
  if (intent === undefined) return;
  await finishRelease(await recordRelease(intent, services), services);
}

export function parseReleaseCommand(argv: readonly string[]): ReleaseCommand {
  const [mode, target] = argv;
  if (mode === undefined || target === undefined) {
    throw new Error("Usage: pnpm release:run main <commit> | retry <record-tag>");
  }
  if (mode === "main") return { mode: "main", commit: assertCommit(target) };
  if (mode === "retry") return { mode: "retry", tag: assertReleaseTag(target) };
  throw new Error("Usage: pnpm release:run main <commit> | retry <record-tag>");
}

export async function executeRelease(command: ReleaseCommand, services: ReleaseServices): Promise<void> {
  if (command.mode === "main") {
    await releaseMain(command.commit, services);
    return;
  }
  const saved = await services.store.find(command.tag);
  if (saved === undefined) throw new Error("No prepared release exists for that tag");
  await finishRelease(saved, services);
}

function productionServices(
  git: GitPort,
  store: ReleaseStore,
  stableGate: StableReleaseGate,
  archive: ArchiveWorkshop
): ReleaseServices {
  return {
    git,
    store,
    registry: readRegistry,
    archive,
    stableGate,
    plannedCanaryBase,
    publishVerified: (release) =>
      publishVerifiedRelease(release, {
        registry: readRegistry,
        publish: (tarball) =>
          run("npm", ["publish", tarball, "--access", "public", "--tag", "pending", "--ignore-scripts"]),
        promote: (version, tag) => run("npm", ["dist-tag", "add", `${packageName}@${version}`, tag]),
        isAncestor: git.isAncestor,
        wait: () => setTimeout(5_000),
      }),
    log: (message) => {
      console.log(message);
    },
  };
}

export async function runRelease(command: ReleaseCommand, repository: string, token: string): Promise<void> {
  const client = createGitHubClient(repository, token);
  const git = createGitPort();
  const store = createReleaseStore(client);
  const stableGate = createStableReleaseGate(client);
  await withArchiveWorkshop(async (archive) => {
    await executeRelease(command, productionServices(git, store, stableGate, archive));
  });
}
