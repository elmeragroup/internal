import { distTagFor, npmIdentity, planPublication } from "./release-policy.ts";
import type { CommitAncestry } from "./release-policy.ts";
import type { VerifiedRelease } from "./release-record.ts";
import type { Registry } from "./release-registry.ts";

export type PublicationServices = {
  registry: () => Promise<Registry>;
  publish: (archive: string) => void;
  promote: (version: string, tag: string) => void;
  isAncestor: CommitAncestry;
  wait: () => Promise<void>;
};

const propagationAttempts = 6;

/** Uploads the archive and returns the first registry read that shows those exact bytes. */
async function uploadAndConfirm(release: VerifiedRelease, services: PublicationServices): Promise<Registry> {
  let failure: Error | undefined;
  try {
    services.publish(release.archive);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    failure = error;
  }
  for (let attempt = 1; attempt <= propagationAttempts; attempt += 1) {
    const registry = await services.registry();
    if (npmIdentity(release, registry) === "match") return registry;
    if (attempt < propagationAttempts) await services.wait();
  }
  throw new Error("Publication could not be verified; retry the recorded release", { cause: failure });
}

async function promoteAndConfirm(release: VerifiedRelease, services: PublicationServices): Promise<void> {
  const tag = distTagFor(release.channel);
  services.promote(release.version, tag);
  const promoted = await services.registry();
  if (promoted.tags.get(tag) !== release.version)
    throw new Error(`npm ${tag} update is not visible; retry the recorded release`);
}

export async function publishVerifiedRelease(
  release: VerifiedRelease,
  services: PublicationServices
): Promise<"published" | "superseded"> {
  const intended = planPublication(release, await services.registry(), services.isAncestor);
  if (intended.kind === "superseded") return "superseded";
  const plan = intended.upload
    ? planPublication(release, await uploadAndConfirm(release, services), services.isAncestor)
    : intended;
  if (plan.kind === "publish" && plan.promote) await promoteAndConfirm(release, services);
  return "published";
}
