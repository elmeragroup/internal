import { describe, expect, it } from "vitest";

import {
  componentSourceFixture,
  exportSymbol,
  inspectNative,
  primaryNode,
  withSession,
} from "./support/component-source.ts";

const facadePath = componentSourceFixture("facade.ts");
const forwardedPath = componentSourceFixture("forwarded.ts");
const starPath = componentSourceFixture("star.ts");
const groupFacadePath = componentSourceFixture("group-facade.ts");

const forwarded = (filePath: string) => [{ status: "forwarded", filePath, packageName: "dep-aria" }];

describe("forwarded dependency values", () => {
  it("records the innermost project module of a re-export chain on the export draft", () => {
    withSession(forwardedPath, (session, draft) => {
      const entry = draft.exports.find((candidate) => candidate.name === "Forwarded");
      expect(entry?.forwardingModulePath).toBe(facadePath);
      expect(
        session.compiler.declarationOwnership(primaryNode(session, exportSymbol(draft, "Forwarded")))
      ).toEqual({ kind: "dependency", packageName: "dep-aria" });
    });
  });

  it.each([
    { form: "a named re-export chain", entry: "forwarded.ts", published: facadePath },
    { form: "a named re-export of the dependency", entry: "facade.ts", published: facadePath },
    { form: "export * from the dependency", entry: "star.ts", published: starPath },
    { form: "alternating stars and named exports", entry: "star-mixed.ts", published: starPath },
    { form: "a same-target diamond", entry: "star-diamond.ts", published: starPath },
    { form: "an explicit export shadowing a star", entry: "star-shadow.ts", published: facadePath },
    { form: "a runtime star after a type-only star", entry: "star-type-only.ts", published: starPath },
    { form: "a star cycle with a dependency exit", entry: "star-cycle-a.ts", published: starPath },
    { form: "consecutive star exports", entry: "star-barrel.ts", published: starPath },
    {
      form: "a named export followed by consecutive stars",
      entry: "named-star-entry.ts",
      published: starPath,
    },
    { form: "a chain ending in export *", entry: "outer-star.ts", published: starPath },
    { form: "an imported binding exported by name", entry: "alias-export.ts", published: undefined },
  ])(
    "publishes a value forwarded through $form from the innermost project module",
    async ({ entry, published }) => {
      const entryPath = componentSourceFixture(entry);
      expect(await inspectNative(entryPath, [{ exportName: "Forwarded" }])).toEqual(
        forwarded(published ?? entryPath)
      );
    }
  );

  it("retains the forwarding route inside a namespace export", async () => {
    expect(
      await inspectNative(componentSourceFixture("star-namespace.ts"), [{ exportName: "Parts.Forwarded" }])
    ).toEqual(forwarded(starPath));
  });

  it("publishes a default export of an imported dependency binding from the exporting module", async () => {
    const entryPath = componentSourceFixture("default-alias.ts");
    expect(await inspectNative(entryPath, [{ exportName: "default" }])).toEqual(forwarded(entryPath));
  });

  it("publishes a member of a forwarded container from the module that aliases the container", async () => {
    const request = [{ exportName: "Group", memberName: "Forwarded" }];
    expect(await inspectNative(groupFacadePath, request)).toEqual(forwarded(groupFacadePath));
    expect(await inspectNative(componentSourceFixture("group-entry.ts"), request)).toEqual(
      forwarded(groupFacadePath)
    );
  });
});
