import { describe, expect, it } from "vitest";

import { ReleaseError, toReleaseError } from "../src/errors.ts";

describe("ReleaseError", () => {
  it("preserves the message for Effect.runPromise failures", () => {
    const error = new ReleaseError({ message: "Checkout differs from the checked commit" });
    expect(error._tag).toBe("ReleaseError");
    expect(error.message).toBe("Checkout differs from the checked commit");
    expect(toReleaseError(error)).toBe(error);
    expect(toReleaseError(new Error("original Merge job")).message).toBe("original Merge job");
  });

  it("keeps the deepest diagnostic cause for wrapped decode failures", () => {
    const wrapped = new Error("release intent is invalid", {
      cause: new Error('Missing key\n  at ["commit"]'),
    });
    expect(toReleaseError(wrapped)).toMatchObject({
      message: "release intent is invalid",
      cause: 'Missing key\n  at ["commit"]',
    });
  });

  it("can carry an original diagnostic cause", () => {
    const error = new ReleaseError({
      message: "Publication could not be verified; retry the recorded release",
      cause: "connection lost",
    });
    expect(error.cause).toBe("connection lost");
    expect(toReleaseError(error).cause).toBe("connection lost");
  });
});
