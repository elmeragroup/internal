import { describe, expect, it } from "vitest";

import { typeNodeKindTableDrift } from "../src/backend/ts7/node-facts.ts";

describe("node kind table", () => {
  it("mirrors the compiler's isTypeNode for every syntax kind", () => {
    expect(typeNodeKindTableDrift()).toEqual([]);
  });
});
