import type { ReleaseIntent } from "./intent.ts";

/**
 * Consumer seam: stamp packed identity, build, pack, verify, and return the
 * durable bundle bytes the engine uploads. Retry never calls this.
 */
export type PackAndVerify = {
  pack: (intent: ReleaseIntent) => Uint8Array;
};
