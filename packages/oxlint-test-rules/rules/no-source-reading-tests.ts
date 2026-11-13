import type { ESTree, Rule } from "@oxlint/plugins";

import { unwrap } from "../shared/ast-walk.ts";
import { anyViolates } from "../shared/quantify.ts";
import { evaluate, isApi } from "../shared/resolve.ts";
import { sourcePaths } from "../shared/source-paths.ts";
import type { Alt } from "../shared/value.ts";

/** The calls that read a file's text, by their resolved last name. */
const READS = new Set(["readFileSync", "readFile", "readFileString"]);

/** A raw import of a code module, which hands the test its text. */
const RAW_CODE_IMPORT = /(?<!\.d)\.[cm]?[jt]sx?\?raw$/u;

/**
 * No source-reading tests: a test does not read a code module's text, by `readFileSync`,
 * `readFile` or `readFileString`, or a static or dynamic `?raw` import, to grep it. A check on how
 * source is spelled goes red on an identifier-only refactor; write it as a lint rule, which states
 * the contract once and reports it in the editor.
 *
 * A path counts as code when a fragment it spells ends in a code extension; when it comes through
 * a reader helper's parameter from a call site that passes a code path; or, for a path taken from
 * a loop binding or a callback parameter, when the list it walks keeps code files. A list keeps
 * code by its values: a glob whose positive pattern names code (`**\/*.ts`), or a directory
 * listing (`readdirSync`, `readdir`, `opendirSync`) or glob narrowed by a recognised positive
 * selector on the element itself or a projection that keeps its name (`dirent.name`,
 * `join(dir, name)`, `basename(name)`), never on another value, that keeps code: `.filter` with `endsWith(".tsx")`, `/\.tsx?$/.test`, `match`,
 * `extname(name) === ".ts"`, `[".ts"].includes(extname(name))` or `EXTENSIONS.some((e) =>
 * name.endsWith(e))`, combined with `&&` (both must keep code) and `||` (either may), and an `if`
 * around the read or around the `push` that fills a list. A negated or unrecognised selector keeps
 * nothing the rule can prove, so `!name.endsWith(".ts")` is no evidence. A helper's suffix
 * parameter (`function list(ext) { … name.endsWith(ext) … }`) keeps what its call sites pass when
 * every site keeps the same, so `list(".ts")` keeps code unless another site passes `".json"`. A
 * `$`-anchored pattern that matches no sample file name keeps what the extensions it ends with
 * name (`/button\.tsx?$/` keeps code), and `.d.ts` endings keep other files. `sort`, `slice` and
 * `reverse` keep the list's selection; `map` and `flatMap` keep it when the callback returns the
 * name or a path built from it (`flatMap` also `[name]`); `concat` joins the selections; and a
 * spread, written in a list literal (`[...list]`) or pushed (`push(...list)`), adds the spread
 * list's selection, skipping a spread of the list itself (a recursive walker's
 * `out.push(...walk(sub))`). A spread the rule cannot follow leaves the whole list unprovable.
 * Reading JSON (a read the resolved `JSON.parse` takes), CSS, Markdown and declaration files stays
 * allowed, and so does reading data the test wrote: a path the same file writes (`writeFileSync`,
 * `writeFile`, `appendFile`, `outputFile`), read as the same value, through a reader or writer
 * helper at each call site that passes it; or a path surely under a temporary directory
 * (`mkdtempSync`, `tmpdir()`): `join` keeps it unless a later segment climbs out with `..`, and
 * `resolve` keeps it only when every later segment is a known relative one. `new URL(spec, base)`
 * names the spec's file in the base's directory.
 *
 * Scope: follows what `resolve.ts` follows, for the reader (named, aliased, namespace or
 * destructured import), the path, the list and its pushes, and finds a helper's call sites as
 * `test-context.ts` does; `shared/source-paths.ts` holds the path model. Beyond that: a reader, listing or writer other than the ones named is
 * not recognised, a list filled another way than `push` is unresolved, and a selector in a callback
 * the rule cannot read keeps nothing it can prove.
 */
export const noSourceReadingTests: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Forbid tests that read code modules as text." },
    messages: {
      source:
        "This test reads a code module's text, which a refactor that keeps behavior breaks. State a source contract as a lint rule, or assert the module's behavior through its exports.",
    },
    schema: [],
  },
  create(context) {
    const { isCodePath, isWrittenByTest, callsOneOf } = sourcePaths(context);

    const checkRawImport = (node: ESTree.Node, source: ESTree.Node): void => {
      const raw = (alternative: Alt): boolean =>
        alternative.kind === "string" && RAW_CODE_IMPORT.test(alternative.value);
      if (anyViolates(evaluate(context, source), raw)) context.report({ node, messageId: "source" });
    };

    /**
     * Whether a read's text goes straight into `JSON.parse`: the call that consumes it, past the
     * wrappers that keep its value (`await`, parentheses, `as`), is `JSON.parse` in every
     * alternative of its callee.
     */
    const parsedAsJson = (read: ESTree.Node): boolean => {
      let value: ESTree.Node = read;
      let consumer = value.parent;
      while (consumer !== null && consumer.type !== "CallExpression" && unwrap(consumer) === unwrap(value)) {
        value = consumer;
        consumer = consumer.parent;
      }
      if (consumer?.type !== "CallExpression" || !consumer.arguments.some((argument) => argument === value))
        return false;
      return isApi(context, consumer.callee, "JSON.parse");
    };

    return {
      ImportDeclaration(node) {
        checkRawImport(node, node.source);
      },
      ImportExpression(node) {
        checkRawImport(node, node.source);
      },
      CallExpression(node) {
        const [path] = node.arguments;
        if (path === undefined || !callsOneOf(node.callee, READS) || parsedAsJson(node)) return;
        if (isWrittenByTest(path)) return;
        if (isCodePath(path, node)) context.report({ node, messageId: "source" });
      },
    };
  },
};
