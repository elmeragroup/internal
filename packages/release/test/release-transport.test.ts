import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { acquireReleaseTransport } from "../src/release-transport.ts";
import { startIdleClosingServer } from "./lib/idle-closing-server.ts";

const request = { method: "GET", signal: AbortSignal.timeout(30_000) } as const;

describe("release transport", () => {
  it("serves requests until its scope closes, then refuses them", async () => {
    const server = await startIdleClosingServer(1_000);
    const url = `${server.origin}/repos/acme/ui/releases/1`;
    const transport = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scoped = yield* acquireReleaseTransport();
          const response = yield* Effect.promise(() => scoped(url, request));
          expect(response.status).toBe(200);
          // Left unread: closing the scope must not wait for this body.
          yield* Effect.promise(() => scoped(`${server.origin}/@acme%2fmissing`, request));
          return scoped;
        })
      )
    );

    await expect(transport(url, request)).rejects.toMatchObject({
      cause: { code: "UND_ERR_DESTROYED" },
    });
  });
});
