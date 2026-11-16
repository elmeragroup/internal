import { describe, expect, it } from "vitest";

import { endingsOf } from "./pattern-endings.ts";

/*
 * Unit under test: `endingsOf`, the endings a `$`-anchored pattern requires.
 * Oracle: the JavaScript regex engine. Every short string the compiled pattern matches must end
 * with one of the endings read from its source; a reader that gives up (`undefined`) claims
 * nothing and passes. The patterns are the escapes with a payload, which a reader that skips the
 * escape letter misreads as literal text, and a `[` nested in a `v`-flag class.
 */

/** Every string of up to four characters over an alphabet that spells the patterns' endings. */
const STRINGS = (() => {
  const alphabet = [".", "t", "s", "x", "a", "e", "<", ">", "0", "2"];
  const strings = [""];
  let layer = [""];
  for (let length = 1; length <= 4; length++) {
    layer = layer.flatMap((prefix) => alphabet.map((character) => prefix + character));
    strings.push(...layer);
  }
  return strings;
})();

describe("endingsOf", () => {
  it.each([
    ["\\x2ets$", ""],
    ["\\u002ets$", ""],
    ["(?<a>x)\\k<a>\\.ts$", ""],
    ["\\.t\\x73$", ""],
    ["\\.ts\\x2e$", ""],
    ["\\.\\u{74}s$", "u"],
    ["[\\x2e]ts$", ""],
    ["[[.]]ts$", "v"],
    ["\\56ts$", ""],
  ])("/%s/%s: every match ends with an ending it reads", (source, flags) => {
    const endings = endingsOf(source, flags);
    const regex = new RegExp(source, flags);
    const escaping = STRINGS.filter(
      (text) => regex.test(text) && endings !== undefined && !endings.some((ending) => text.endsWith(ending))
    );
    expect(escaping.slice(0, 3)).toEqual([]);
  });
});
