import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { lift, liftPromise, ReleaseError } from "../src/errors.ts";

describe("ReleaseError", () => {
  it("carries the raising port and message", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        lift("git", () => {
          throw new Error("Checkout differs from the checked commit");
        })
      )
    );
    expect(failure).toMatchObject({
      _tag: "ReleaseError",
      port: "git",
      message: "Checkout differs from the checked commit",
    });
  });

  it("keeps the deepest diagnostic cause for wrapped decode failures", async () => {
    const wrapped = new Error("release intent is invalid", {
      cause: new Error('Missing key\n  at ["commit"]'),
    });
    const failure = await Effect.runPromise(
      Effect.flip(
        lift("store", () => {
          throw wrapped;
        })
      )
    );
    expect(failure).toMatchObject({
      message: "release intent is invalid",
      cause: 'Missing key\n  at ["commit"]',
    });
  });

  it("normalizes a non-Error rejection", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(liftPromise("registry", () => Promise.reject("offline")))
    );
    expect(failure).toMatchObject({
      _tag: "ReleaseError",
      port: "registry",
      message: "Release operation failed",
    });
  });

  it("preserves an explicit diagnostic cause", () => {
    const error = new ReleaseError({
      port: "publication",
      message: "Publication could not be verified; retry the recorded release",
      cause: "connection lost",
    });
    expect(error.cause).toBe("connection lost");
  });
});
