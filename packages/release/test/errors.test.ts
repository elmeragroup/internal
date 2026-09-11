import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { lift, liftPromise, ReleaseError } from "../src/errors.ts";

describe("ReleaseError", () => {
  it("carries the failure message and the original cause", async () => {
    const original = new Error("Checkout differs from the checked commit");
    const failure = await Effect.runPromise(
      Effect.flip(
        lift(() => {
          throw original;
        })
      )
    );
    expect(failure).toMatchObject({
      _tag: "ReleaseError",
      message: "Checkout differs from the checked commit",
    });
    expect(failure.cause).toBe(original);
  });

  it("keeps the original error chain instead of flattening it", async () => {
    const wrapped = new Error("release intent is invalid", {
      cause: new Error('Missing key\n  at ["commit"]'),
    });
    const failure = await Effect.runPromise(
      Effect.flip(
        lift(() => {
          throw wrapped;
        })
      )
    );
    expect(failure.message).toBe("release intent is invalid");
    expect(failure.cause).toBe(wrapped);
  });

  it("normalizes a non-Error rejection", async () => {
    const failure = await Effect.runPromise(Effect.flip(liftPromise(() => Promise.reject("offline"))));
    expect(failure).toMatchObject({
      _tag: "ReleaseError",
      message: "Release operation failed",
      cause: "offline",
    });
  });

  it("preserves an explicit cause", () => {
    const error = new ReleaseError({
      message: "Publication could not be verified; retry the recorded release",
      cause: "connection lost",
    });
    expect(error.cause).toBe("connection lost");
  });
});
