import { describe, expect, it } from "vitest";

import { PathNameOwnershipCache, classifySourceFile } from "../src/backend/ts7/file-ownership.ts";
import type { AuthoredIntroduction } from "../src/backend/ts7/module-ordering.ts";
import { authoredPositionsOf } from "../src/backend/ts7/module-ordering.ts";
import { memoizeSubjectFact, memoizeWalkFact } from "../src/backend/ts7/module-walk-memo.ts";

/** Stands in for one module walk; the memo keys it by identity only. */
type Walk = { readonly walk: string };
/** Stands in for one compiler symbol; the memo keys it by identity only. */
type Subject = { readonly name: string };

describe("path-name ownership memo", () => {
  it("classifies each distinct path once and forgets it on clear", () => {
    const cache = new PathNameOwnershipCache();
    const path = "/repo/node_modules/pkg/index.d.ts";

    const first = cache.classify(path);
    expect(first).toStrictEqual(classifySourceFile(path));
    expect(cache.classify(path)).toBe(first);
    expect(cache.classify("/repo/src/index.ts")).toStrictEqual({ kind: "project" });

    cache.clear();
    const afterClear = cache.classify(path);
    expect(afterClear).toStrictEqual(first);
    expect(afterClear).not.toBe(first);
  });
});

describe("authored introduction positions", () => {
  const introductions: readonly AuthoredIntroduction[] = [
    { position: 10, declaredName: "declaredEarly" },
    { position: 20, clauseElementNames: ["declaredEarly"] },
    { position: 30, clauseName: "Namespaced" },
    { position: 40, clauseElementNames: ["Namespaced"] },
    { position: 50, declaredName: "onlyDeclared" },
  ];

  it("prefers an explicit export clause over an earlier declaration of the same name", () => {
    const positions = authoredPositionsOf(introductions);

    expect(positions.get("declaredEarly")).toBe(20);
    expect(positions.get("Namespaced")).toBe(30);
    expect(positions.get("onlyDeclared")).toBe(50);
    expect(positions.get("absent")).toBeUndefined();
  });

  it("keeps the first statement of each group when a name repeats", () => {
    const positions = authoredPositionsOf([
      { position: 5, clauseElementNames: ["repeated", "repeated"] },
      { position: 15, clauseName: "repeated" },
      { position: 25, declaredName: "declaredTwice" },
      { position: 35, declaredName: "declaredTwice" },
    ]);

    expect(positions.get("repeated")).toBe(5);
    expect(positions.get("declaredTwice")).toBe(25);
  });
});

describe("module-walk memos", () => {
  it("reads one subject's fact once per walk and never across walks", () => {
    let reads = 0;
    const read = memoizeWalkFact((_walk: Walk, subject: Subject) => {
      reads += 1;
      return subject.name === "forwarded";
    });
    const walk: Walk = { walk: "first" };
    const forwarded: Subject = { name: "forwarded" };

    expect(read(walk, forwarded)).toBe(true);
    expect(read(walk, forwarded)).toBe(true);
    expect(reads).toBe(1);

    expect(read(walk, { name: "local" })).toBe(false);
    expect(reads).toBe(2);

    expect(read({ walk: "second" }, forwarded)).toBe(true);
    expect(reads).toBe(3);
  });

  it("caches an absent fact rather than re-reading it", () => {
    let reads = 0;
    const read = memoizeWalkFact((_walk: Walk, _subject: Subject) => {
      reads += 1;
      return undefined;
    });
    const walk: Walk = { walk: "only" };
    const subject: Subject = { name: "local" };

    expect(read(walk, subject)).toBeUndefined();
    expect(read(walk, subject)).toBeUndefined();
    expect(reads).toBe(1);
  });

  it("builds one subject's derived record once however many callers ask", () => {
    let builds = 0;
    const positionsOf = memoizeSubjectFact((subject: Subject) => {
      builds += 1;
      return authoredPositionsOf([{ position: 1, declaredName: subject.name }]);
    });
    const container: Subject = { name: "container" };

    const first = positionsOf(container);
    for (const _ of [0, 1, 2]) expect(positionsOf(container)).toBe(first);

    expect(builds).toBe(1);
    expect(positionsOf({ name: "container" })).not.toBe(first);
    expect(builds).toBe(2);
  });
});
