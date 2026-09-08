import { createRuleTester } from "../shared/rule-tester.ts";
import { noSlopCommentsRule } from "./no-slop-comments.ts";

const tester = createRuleTester();

tester.run("anti-slop/no-slop-comments", noSlopCommentsRule, {
  valid: [
    "// Upstream sends TT0100 for legacy meters, which our enum cannot represent.\nconst a = 1;",
    "// Retries twice because the vendor gateway drops the first call after idle.\nconst a = 1;",
    "// TODO(ELM-123): migrate once the v2 endpoint ships.\nconst a = 1;",
    {
      name: "default ticketPattern accepts any Jira-style key",
      code: "// TODO(OPS-42): migrate once the v2 endpoint ships.\nconst a = 1;",
    },
    {
      name: "empty options object still uses the schema default ticketPattern",
      code: "// TODO(OPS-42): migrate once the v2 endpoint ships.\nconst a = 1;",
      options: [{}],
    },
    {
      name: "configured ticketPattern accepts the repo key",
      code: "// TODO(ELM-123): migrate once the v2 endpoint ships.\nconst a = 1;",
      options: [{ ticketPattern: "ELM-\\d+" }],
    },
    "// TODO: blocked on https://github.com/oxc-project/oxc/issues/1\nconst a = 1;",
    "// TODO: blocked on https://github.com/oxc-project/oxc/issues/1.\nconst a = 1;",
    "// TODO: blocked on https://github.com/oxc-project/oxc/issues/1?view=all#issuecomment-1\nconst a = 1;",
    "// TODO: blocked on https://gitlab.com/group/project/-/issues/42\nconst a = 1;",
    "// TODO: blocked on https://gitlab.com/group/project/-/issues/42?scope=all\nconst a = 1;",
    "// TODO: blocked on https://jira.example.com/browse/OPS-42\nconst a = 1;",
    "// TODO: blocked on https://jira.example.com/browse/OPS-42, pending rollout\nconst a = 1;",
    "// TODO: blocked on https://jira.example.com/browse/OPS-42#details\nconst a = 1;",
    "// TODO: blocked on https://linear.app/elmera/issue/OPS-42/fix-cache\nconst a = 1;",
    "// TODO: blocked on https://linear.app/elmera/issue/OPS-42/fix-cache?view=full#activity\nconst a = 1;",
    "// Guard against the double-submit race in Safari.\nsetLoading(false);",
    "/** IMPORTANT: callers must dispose the returned handle. */\nexport function f() {}",
    "// @ts-expect-error the vendor types omit this field, do not remove\nconst a = b;",
    "// eslint-disable-next-line no-console\nconsole.log(1);",
    "// oxlint-disable-next-line no-console\nconsole.log(1);",
    "// prettier-ignore\nconst matrix = [1, 2, 3];",
    "/*\n * Copyright 2026 Elmera Group.\n * SPDX-License-Identifier: MIT\n */\nexport const a = 1;",
    "// MIT License\n// DO NOT REMOVE THIS HEADER\nexport const a = 1;",
    "/*\n * MIT License\n * DO NOT REMOVE THIS HEADER\n */\nexport const a = 1;",
    "/* @license MIT */\n// DO NOT REMOVE THIS HEADER\nexport const a = 1;",
    "// ----------------------------------\n// Copyright 2026 Elmera Group\n// SPDX-License-Identifier: MIT\nexport const a = 1;",
    "// @license MIT\n// ----------------------------------\nexport const a = 1;",
    "// SAFETY: IMPORTANT invariant checked above — index is within bounds.\nconst b = a as UserId;",
    {
      name: "prose ending with a semicolon is not commented-out code",
      code: "// Callers must dispose the returned handle before unmount;\nconst a = 1;",
    },
    {
      name: "TODO with an RFC reference may stay",
      code: "// TODO: blocked on RFC 9110 language around idempotency.\nconst a = 1;",
    },
    "// Single-height field box: pins the `md` control rung.\nconst a = 1;",
    "// neutral: primary-colored bar at every level (no good/bad semantics, no icon)\nconst a = 1;",
    "// variant axes (e.g. media image sizes) are not density rungs, so only\n// base is scanned.\nconst a = 1;",
    "// glyph already wins and the important flag it used to carry was noise.\nconst a = 1;",
    "// returns the cached value when the vendor omits the etag header\nconst a = 1;",
    "// return the cached value when the vendor omits the etag header\nconst a = 1;",
    "// return the cached value when the vendor omits the etag header;\nconst a = 1;",
    "// await the response from the vendor;\nconst a = 1;",
  ],
  invalid: [
    {
      code: "// ----------------------------------\nconst a = 1;",
      errors: [
        {
          messageId: "bannerComment",
          suggestions: [{ messageId: "removeComment", output: "const a = 1;" }],
        },
      ],
    },
    {
      code: "// ===== Helpers =====\nconst a = 1;",
      errors: [{ messageId: "bannerComment" }],
    },
    {
      code: "/* ********** */\nconst a = 1;",
      errors: [
        {
          messageId: "bannerComment",
          suggestions: [{ messageId: "removeComment", output: "const a = 1;" }],
        },
      ],
    },
    {
      code: "// const total = price * quantity;\nconst a = 1;",
      errors: [{ messageId: "commentedOutCode" }],
    },
    {
      name: "uninitialized variable declaration is a corpse",
      code: "// let cached;\nconst a = 1;",
      errors: [{ messageId: "commentedOutCode" }],
    },
    {
      name: "simple assignment is a corpse",
      code: "// cached = nextValue;\nconst a = 1;",
      errors: [{ messageId: "commentedOutCode" }],
    },
    {
      code: "/*\nif (user) {\n  return user.name;\n}\n*/\nconst a = 1;",
      errors: [
        {
          messageId: "commentedOutCode",
          suggestions: [{ messageId: "removeComment", output: "const a = 1;" }],
        },
      ],
    },
    {
      code: "// return <UserCard id={id} />\nconst a = 1;",
      errors: [{ messageId: "commentedOutCode" }],
    },
    {
      name: "return call is a corpse",
      code: "// return fetchUser();\nconst a = 1;",
      errors: [{ messageId: "commentedOutCode" }],
    },
    {
      name: "single-line function call is a corpse",
      code: "// refreshCache();\nconst a = 1;",
      errors: [{ messageId: "commentedOutCode" }],
    },
    {
      name: "nested function call is a corpse",
      code: "// refreshCache(getKey());\nconst a = 1;",
      errors: [{ messageId: "commentedOutCode" }],
    },
    {
      name: "function call inside a block comment is a corpse",
      code: "/*\nsendRequest(url, options);\n*/\nconst a = 1;",
      errors: [
        {
          messageId: "commentedOutCode",
          suggestions: [{ messageId: "removeComment", output: "const a = 1;" }],
        },
      ],
    },
    {
      name: "balanced multiline function call is a corpse",
      code: "/*\nsendRequest(\n  url,\n  options,\n);\n*/\nconst a = 1;",
      errors: [{ messageId: "commentedOutCode" }],
    },
    {
      name: "adjacent line comments form one call corpse",
      code: "// sendRequest(\n//   url,\n//   options,\n// );\nconst a = 1;",
      errors: [
        {
          messageId: "commentedOutCode",
          suggestions: [{ messageId: "removeComment", output: "const a = 1;" }],
        },
      ],
    },
    {
      code: "// IMPORTANT: keep this ordering\nconst a = 1;",
      errors: [{ messageId: "panicComment" }],
    },
    {
      code: "// do not remove, the build breaks without it\nconst a = 1;",
      errors: [{ messageId: "panicComment" }],
    },
    {
      code: "// too risky to change before the release\nconst a = 1;",
      errors: [{ messageId: "panicComment" }],
    },
    {
      code: "// this is fine for now\nconst a = 1;",
      errors: [{ messageId: "panicComment" }],
    },
    {
      code: "// TODO: clean this up later\nconst a = 1;",
      errors: [{ messageId: "todoWithoutLink" }],
    },
    {
      name: "configured ticketPattern rejects keys from other projects",
      code: "// TODO(OPS-42): migrate once the v2 endpoint ships.\nconst a = 1;",
      options: [{ ticketPattern: "ELM-\\d+" }],
      errors: [{ messageId: "todoWithoutLink" }],
    },
    {
      code: "// FIXME flaky under load\nconst a = 1;",
      errors: [{ messageId: "todoWithoutLink" }],
    },
    {
      code: "// HACK around the pagination bug\nconst a = 1;",
      errors: [
        {
          message:
            "A TODO, FIXME, HACK, or XXX without a tracker or RFC reference is a wish, not a plan. Add a reference or delete it.",
        },
      ],
    },
    {
      name: "generic HTTP URL inside commented-out code is still a corpse",
      code: '// const url = "https://api.example.com/v1";\nconst a = 1;',
      errors: [{ messageId: "commentedOutCode" }],
    },
    {
      name: "tracker URL does not exempt commented-out code",
      code: '// const url = "https://github.com/oxc-project/oxc/issues/1";\nconst a = 1;',
      errors: [{ messageId: "commentedOutCode" }],
    },
    {
      name: "license in a mid-file statement is not a legal header",
      code: "const a = 1;\n// const license = loadLicense();\nconst b = 2;",
      errors: [{ messageId: "commentedOutCode" }],
    },
    {
      name: "blank line ends the leading legal header",
      code: "// MIT License\n\n// DO NOT REMOVE THIS HEADER\nconst a = 1;",
      errors: [{ messageId: "panicComment" }],
    },
    {
      name: "later license text does not launder an earlier corpse",
      code: "// refreshCache();\n// MIT License\nconst a = 1;",
      errors: [{ messageId: "commentedOutCode" }],
    },
    {
      name: "leading legal header does not absorb an adjacent corpse",
      code: "/* MIT License */\n// refreshCache();\nconst a = 1;",
      errors: [{ messageId: "commentedOutCode" }],
    },
    {
      name: "ISO-8601 in panic prose is not a tracker id",
      code: "// IMPORTANT: timestamps must be ISO-8601\nconst a = 1;",
      errors: [{ messageId: "panicComment" }],
    },
    {
      name: "HTTP-2 does not satisfy a TODO",
      options: [{ ticketPattern: "ELM-\\d+" }],
      code: "// TODO: upgrade the transport to HTTP-2\nconst a = 1;",
      errors: [{ messageId: "todoWithoutLink" }],
    },
    {
      name: "Linear non-issue page does not satisfy a TODO",
      code: "// TODO: follow https://linear.app/docs for setup\nconst a = 1;",
      errors: [{ messageId: "todoWithoutLink" }],
    },
    {
      name: "GitHub issue route with an extra path does not satisfy a TODO",
      code: "// TODO: follow https://github.com/a/b/issues/42/not-an-issue\nconst a = 1;",
      errors: [{ messageId: "todoWithoutLink" }],
    },
    {
      name: "GitHub issue number with a host-like suffix does not satisfy a TODO",
      code: "// TODO: follow https://github.com/a/b/issues/42.evil\nconst a = 1;",
      errors: [{ messageId: "todoWithoutLink" }],
    },
    {
      name: "invalid tracker URL does not fall back to its embedded project ticket",
      options: [{ ticketPattern: "ELM-\\d+" }],
      code: "// TODO: follow https://linear.app/elmera/issue/ELM-123.evil\nconst a = 1;",
      errors: [{ messageId: "todoWithoutLink" }],
    },
    {
      name: "TLS-13 does not satisfy a TODO",
      options: [{ ticketPattern: "ELM-\\d+" }],
      code: "// TODO: upgrade the transport to TLS-13\nconst a = 1;",
      errors: [{ messageId: "todoWithoutLink" }],
    },
    {
      name: "ADR-0002 does not satisfy a TODO",
      options: [{ ticketPattern: "ELM-\\d+" }],
      code: "// TODO: reconcile this with ADR-0002\nconst a = 1;",
      errors: [{ messageId: "todoWithoutLink" }],
    },
    {
      name: "SHA-256 does not satisfy a TODO",
      options: [{ ticketPattern: "ELM-\\d+" }],
      code: "// TODO: migrate the digest to SHA-256\nconst a = 1;",
      errors: [{ messageId: "todoWithoutLink" }],
    },
    {
      name: "CC-BY-4 does not satisfy a TODO",
      options: [{ ticketPattern: "ELM-\\d+" }],
      code: "// TODO: verify the CC-BY-4 attribution\nconst a = 1;",
      errors: [{ messageId: "todoWithoutLink" }],
    },
    {
      name: "generic URL does not satisfy an unlinked TODO",
      code: "// TODO: retry against https://api.example.com/v1\nconst a = 1;",
      errors: [{ messageId: "todoWithoutLink" }],
    },
    {
      name: "banner with a tracker URL is still a banner",
      code: "// ===== see https://linear.app/elmera/issue/1 =====\nconst a = 1;",
      errors: [{ messageId: "bannerComment" }],
    },
    {
      name: "multiline object with comma-terminated properties is a corpse",
      code: "/*\nconst config = {\n  timeout: 30,\n  retries: 2,\n};\n*/\nconst a = 1;",
      errors: [{ messageId: "commentedOutCode" }],
    },
    {
      name: "inline block between keyword and identifier has no removal",
      code: "function f(){ return/* TODO */x; }",
      errors: [{ messageId: "todoWithoutLink", suggestions: null }],
    },
    {
      name: "inline block between operands has no removal",
      code: "const c = a/* TODO */+b;",
      errors: [{ messageId: "todoWithoutLink", suggestions: null }],
    },
    {
      name: "multi-line block after return has no removal",
      code: "function f(){ return /*\n TODO\n*/ x; }",
      errors: [{ messageId: "todoWithoutLink", suggestions: null }],
    },
    {
      name: "CRLF multi-line block after return has no removal",
      code: "function f(){ return /*\r\n TODO\r\n*/ x; }",
      errors: [{ messageId: "todoWithoutLink", suggestions: null }],
    },
    {
      name: "block that starts its line keeps its removal",
      code: "/* TODO */ const a = 1;",
      errors: [
        {
          messageId: "todoWithoutLink",
          suggestions: [{ messageId: "removeComment", output: " const a = 1;" }],
        },
      ],
    },
    {
      name: "block that ends its line keeps its removal",
      code: "const a = 1; /* TODO */\nconst b = 2;",
      errors: [
        {
          messageId: "todoWithoutLink",
          suggestions: [{ messageId: "removeComment", output: "const a = 1;\nconst b = 2;" }],
        },
      ],
    },
    {
      name: "indented standalone line comment keeps its line terminator",
      code: "const a = 1;\n  // TODO later\n  const b = 2;",
      errors: [
        {
          messageId: "todoWithoutLink",
          suggestions: [{ messageId: "removeComment", output: "const a = 1;\n  const b = 2;" }],
        },
      ],
    },
    {
      name: "CRLF standalone line comment removes one line",
      code: "const a = 1;\r\n// TODO later\r\nconst b = 2;",
      errors: [
        {
          messageId: "todoWithoutLink",
          suggestions: [{ messageId: "removeComment", output: "const a = 1;\r\nconst b = 2;" }],
        },
      ],
    },
    {
      name: "trailing line comment keeps the newline",
      code: "function f(){ return// TODO\n x; }",
      errors: [
        {
          messageId: "todoWithoutLink",
          suggestions: [{ messageId: "removeComment", output: "function f(){ return\n x; }" }],
        },
      ],
    },
  ],
});
