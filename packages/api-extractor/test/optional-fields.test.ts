import { describe, expect, it } from "vitest";

import { definedFields, flagFields } from "../src/optional-fields.ts";

describe("definedFields", () => {
  it("drops undefined values and keeps defined ones, including falsy", () => {
    const fields = definedFields({
      present: 1,
      missing: undefined,
      zero: 0,
      empty: "",
      off: false,
      none: null,
    });

    expect(fields).toEqual({ present: 1, zero: 0, empty: "", off: false, none: null });
    expect(Object.hasOwn(fields, "missing")).toBe(false);
    expect(JSON.stringify(fields)).toBe('{"present":1,"zero":0,"empty":"","off":false,"none":null}');
  });

  it("types absent keys as absent, not explicitly undefined", () => {
    const required: number = 1;
    const optional: string | undefined = undefined;
    const fields = definedFields({ required, optional });
    const exact: { required: number; optional?: string } = fields;
    expect(exact.required).toBe(1);
    expect(Object.hasOwn(exact, "optional")).toBe(false);
  });
});

describe("flagFields", () => {
  it("keeps only the flags that are true", () => {
    const flags = flagFields({ isError: true, isUnion: false, isEnum: true });

    expect(flags).toEqual({ isError: true, isEnum: true });
    expect(Object.hasOwn(flags, "isUnion")).toBe(false);
    expect(JSON.stringify(flags)).toBe('{"isError":true,"isEnum":true}');
  });
});
