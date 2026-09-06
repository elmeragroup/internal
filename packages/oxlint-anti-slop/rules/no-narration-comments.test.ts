import { createRuleTester } from "../shared/rule-tester.ts";
import { noNarrationCommentsRule } from "./no-narration-comments.ts";

const tester = createRuleTester();

tester.run("anti-slop/no-narration-comments", noNarrationCommentsRule, {
  valid: [
    "// Guard against the double-submit race in Safari.\nsetLoading(false);",
    "// variant axes (e.g. media image sizes) are not density rungs, so only\n// base is scanned.\nconst a = 1;",
    "// returns the cached value when the vendor omits the etag header\nconst a = 1;",
    "// glyph already wins and the important flag it used to carry was noise.\nconst a = 1;",
    "/** fetch the user */\nconst user = fetchUser();",
    {
      name: "a two-line comment is compared against the code, not its own second line",
      code: "// fetch the user\n// fetch the user from the vendor cache, not the store\nconst a = 1;",
    },
  ],
  invalid: [
    {
      code: "// fetch the user\nconst user = fetchUser();",
      errors: [{ messageId: "narrationComment" }],
    },
    {
      name: "camelCase narration is normalized like the code identifier",
      code: "// fetchUser\nfetchUser();",
      errors: [{ messageId: "narrationComment" }],
    },
    {
      name: "narration is found through a following comment line",
      code: "// fetch the user\n// (keeps the stale one on failure)\nconst user = fetchUser();",
      errors: [{ messageId: "narrationComment" }],
    },
    {
      code: "// set loading to false\nsetLoading(false);",
      errors: [{ messageId: "narrationComment" }],
    },
  ],
});
