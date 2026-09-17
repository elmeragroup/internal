import { describe, expect, it } from "vitest";

import { ApiArtifactsDriftError, ApiArtifactsError } from "../src/index.ts";

describe("api artifact errors", () => {
  it("keeps names, messages, and structured fields for existing consumers", () => {
    const failure = new ApiArtifactsError(["button: no call signature", "dialog: missing JSDoc"]);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toBeInstanceOf(ApiArtifactsError);
    expect(failure.name).toBe("ApiArtifactsError");
    expect(failure.message).toBe(
      "API artifact generation failed:\nbutton: no call signature\ndialog: missing JSDoc"
    );
    expect(failure.problems).toEqual(["button: no call signature", "dialog: missing JSDoc"]);

    const drift = new ApiArtifactsDriftError(["/project/docs/button/api.json"]);
    expect(drift).toBeInstanceOf(Error);
    expect(drift).toBeInstanceOf(ApiArtifactsDriftError);
    expect(drift.name).toBe("ApiArtifactsDriftError");
    expect(drift.message).toBe("API artifacts are missing or stale:\n/project/docs/button/api.json");
    expect(drift.files).toEqual(["/project/docs/button/api.json"]);
  });

  it("snapshots the structured fields away from the caller's array", () => {
    const problems = ["one"];
    const failure = new ApiArtifactsError(problems);
    problems.push("two");
    expect(failure.problems).toEqual(["one"]);
    expect(failure.message).toBe("API artifact generation failed:\none");
  });

  it("branches on the stable tag without an instanceof check", () => {
    const describeFailure = (error: ApiArtifactsError | ApiArtifactsDriftError): string => {
      switch (error._tag) {
        case "ApiArtifactsError":
          return `generation:${String(error.problems.length)}`;
        case "ApiArtifactsDriftError":
          return `drift:${String(error.files.length)}`;
      }
    };
    expect(describeFailure(new ApiArtifactsError(["a", "b"]))).toBe("generation:2");
    expect(describeFailure(new ApiArtifactsDriftError(["file"]))).toBe("drift:1");
  });
});
