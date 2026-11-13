import type { Context, ESTree } from "@oxlint/plugins";

import { memberName } from "./ast-names.ts";
import { descendants, unwrap } from "./ast-walk.ts";
import type { Mutation } from "./mutations.ts";
import { endingsOf } from "./pattern-endings.ts";
import { anyViolates } from "./quantify.ts";
import { calleeTargets, evaluate, mutationsOf, returnedValues } from "./resolve.ts";
import { staticText } from "./static-text.ts";
import { callSitesOf } from "./test-context.ts";
import { Analysis, isolated, pairKey } from "./traversal.ts";
import { plain, product, stringValues } from "./value.ts";
import type { Alt } from "./value.ts";

/**
 * What a path a test reads names, for `no-source-reading-tests`: the file it spells, the list it
 * walks and what that list keeps, and whether the test wrote it. Each recursive question is one
 * analysis on `traversal.ts`'s bounded traversal, so it shares the evaluator's memo and budget,
 * and a walk past the budget answers "not code".
 */

/** The calls that write a file's text, by their resolved last name, the path first. */
const WRITES = new Set([
  "writeFileSync",
  "writeFile",
  "writeFileString",
  "appendFileSync",
  "appendFile",
  "outputFileSync",
  "outputFile",
]);

/** The calls that list every entry of a directory. */
const DIRECTORY_LISTINGS = new Set(["readdirSync", "readdir", "opendirSync"]);

/** The calls that list the files a glob pattern matches, the pattern first. */
const GLOB_LISTINGS = new Set(["globSync", "glob"]);

/** The calls that make or name a temporary directory, which holds no source module. */
const TEMP_DIRECTORIES = new Set(["mkdtempSync", "mkdtemp", "tmpdir", "makeTempDirectory"]);

/** The calls that join path segments, keeping every one: `join(a, b)`. */
const JOINERS = new Set(["join"]);

/** The calls that resolve path segments, an absolute later segment dropping the ones before it. */
const RESOLVERS = new Set(["resolve"]);

/** The calls that convert a path or file URL without changing the file it names. */
const CONVERTERS = new Set(["fileURLToPath", "pathToFileURL"]);

/** The `Dirent` members that name the directory a walked entry sits in. */
const DIRENT_DIRECTORIES = new Set(["parentPath", "path"]);

/** The calls that keep the file a name names: a path builder's last segment or its base name. */
const NAME_KEEPERS = new Set(["join", "resolve", "basename", "fileURLToPath"]);

/** The string methods that keep the file a name names. */
const NAME_METHODS = new Set(["toLowerCase", "toUpperCase", "trim", "toString"]);

/** The array steps that keep a list's names as they are, in another order or part. */
const KEEPING_STEPS = new Set(["sort", "toSorted", "slice", "reverse", "toReversed"]);

/** The array steps whose callback maps each name to a new value. */
const MAPPING_STEPS = new Set(["map", "flatMap"]);

/** The array methods whose callback's first parameter is each element of the receiver. */
const ELEMENT_CALLBACKS = new Set([
  "some",
  "every",
  "find",
  "findIndex",
  "filter",
  "forEach",
  "map",
  "flatMap",
]);

/** The array methods that ask whether some element matches a callback. */
const SOME_STEPS = new Set(["some", "every", "find", "findIndex"]);

/** A code module's file name: TypeScript or JavaScript, declaration files aside. */
const CODE_FILE = /(?<!\.d)\.[cm]?[jt]sx?$/u;

/** Any file extension at the end of a path fragment. */
const EXTENSION = /\.[a-z0-9]+$/iu;

/** A glob that keeps code files by their end: `**\/*.ts`, `*.{ts,tsx}`. */
const CODE_GLOB = /\*\.(?:[cm]?[jt]sx?|\{[^}]*\b[cm]?[jt]sx?\b[^}]*\})$/u;

/** File names a pattern that keeps code files matches. */
const CODE_SAMPLES = ["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx", "a.mjs", "a.cjs"];

/** File names a pattern that keeps only code files does not match. */
const OTHER_SAMPLES = ["a.json", "a.log", "a.md", "a.css", "a.d.ts.map", "a.txt"];

/** A code extension at the end of a name, in any case and declaration files included. */
const CODE_EXTENSION = /\.[cm]?[jt]sx?$/iu;

/** A declaration file's extension at the end of a name, in any case: no code module. */
const DECLARATION_EXTENSION = /\.d\.[cm]?ts$/iu;

/** A URL with a scheme, which a base URL does not change. */
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/iu;

/**
 * What a list of paths keeps: `code` when a positive selector keeps code files, `other` when a
 * positive selector keeps only other files, `any` when nothing the rule recognises selects.
 */
type Selection = "code" | "other" | "any";

/**
 * What a path spells: its literal fragments, the walk-shaped values (a callback parameter or a
 * loop binding) it is computed from, and whether it is surely under a temporary directory.
 */
type PathSpelling = {
  readonly fragments: ReadonlyArray<string>;
  readonly walked: ReadonlyArray<Alt>;
  readonly temporary: boolean;
};

/** A path value the file writes, as a read of the same value is matched: a string, or the node of a value the evaluator keeps. */
type Identity = string | ESTree.Node;

/** A spelling of nothing the rule can name. */
const NOTHING: PathSpelling = { fragments: [], walked: [], temporary: false };

/** The constructor a `new URL(path, base)` spells a path through. */
const URL_CONSTRUCTOR = new Set(["URL"]);

/** The call that reads a path's extension. */
const EXTNAME = new Set(["extname"]);

/**
 * What a spelling's own text names: other under a temporary directory, else code or other by its
 * last fragment with an extension; `undefined` when it names no file, so its walked lists decide.
 */
function namedSelection({ fragments, temporary }: PathSpelling): "code" | "other" | undefined {
  if (temporary) return "other";
  const named = [...fragments].reverse().find((fragment) => EXTENSION.test(fragment));
  if (named === undefined) return undefined;
  return CODE_FILE.test(named) ? "code" : "other";
}

/** Each opaque path expression's spellings. */
const SPELLINGS = new Analysis<ReadonlyArray<PathSpelling>>([NOTHING]);

/** The list methods that reorder a list in place. */
const PERMUTING = new Set(["sort", "reverse"]);

/** What each list expression keeps, every alternative joined; `undefined` for no list. */
const LISTS = new Analysis<Selection | undefined>(undefined);

/** What each test on a file name keeps, per element it tests. */
const TESTS = new Analysis<Selection>("any");

/**
 * What each `endsWith` argument keeps, by the suffixes it may be. A helper's parameter
 * (`list(".ts")`) is judged at every call site and keeps something provable only when all agree.
 */
const SUFFIXES = new Analysis<Selection>("any");

/** Whether each expression is the element a selector tests, or a projection that keeps its name. */
const SUBJECTS = new Analysis<boolean>(false);

/** Whether each path read at a point may name a code module. */
const CODE_PATHS = new Analysis<boolean>(false);

/** The identities each path expression may be written as. */
const WRITTEN = new Analysis<ReadonlySet<Identity>>(new Set());

/** Each file's written identities. */
const WRITTEN_BY_FILE = new WeakMap<ESTree.Node, ReadonlySet<Identity>>();

/** Both selections at once: a filter on a list. */
function both(left: Selection, right: Selection): Selection {
  if (left === "other" || right === "other") return "other";
  return left === "code" || right === "code" ? "code" : "any";
}

/** Either selection: a list joined to another, or a predicate with `||`. */
function either(left: Selection, right: Selection): Selection {
  if (left === "code" || right === "code") return "code";
  return left === "other" && right === "other" ? "other" : "any";
}

/** What a list of file names or extensions keeps: code when any is code, other when every one names another file. */
function selectionOfNames(names: ReadonlyArray<string>): Selection {
  if (names.some((name) => CODE_FILE.test(name))) return "code";
  return names.length > 0 && names.every((name) => EXTENSION.test(name)) ? "other" : "any";
}

/** What several alternatives' selections keep together: code when any does, unresolved when one is. */
function joined(selections: ReadonlyArray<Selection | undefined>): Selection | undefined {
  if (selections.includes("code")) return "code";
  if (selections.length === 0) return undefined;
  let selection: Selection = "other";
  for (const one of selections) {
    if (one === undefined) return undefined;
    selection = either(selection, one);
  }
  return selection;
}

/**
 * What a pattern keeps by the endings its source requires (`pattern-endings.ts`): other when every
 * ending is a declaration file's extension (`.d.ts`, as `endsWith(".d.ts")` is) or an extension
 * that is no code extension; code when every ending is a code extension, a declaration one
 * included, and not every one is a declaration; nothing provable otherwise, or when the endings
 * cannot be read.
 */
function selectionOfEndings(regex: RegExp): Selection {
  const endings = endingsOf(regex.source, regex.flags);
  if (endings === undefined || endings.length === 0) return "any";
  const isDeclaration = (ending: string) => DECLARATION_EXTENSION.test(ending);
  const isOther = (ending: string) => EXTENSION.test(ending) && !CODE_EXTENSION.test(ending);
  if (endings.every((ending) => isDeclaration(ending) || isOther(ending))) return "other";
  return endings.every((ending) => CODE_EXTENSION.test(ending)) ? "code" : "any";
}

/** Whether a fragment climbs out of the directory before it: a `..` segment. */
function climbs(fragment: string): boolean {
  return fragment.split(/[\\/]/u).includes("..");
}

/**
 * The node that names an element: its callback for a callback's first parameter, its iterable for a
 * loop binding. No other value is an element, so the node covers everything an element is.
 */
function elementKey(element: Alt): ESTree.Node | undefined {
  if (element.kind === "parameter") return element.index === 0 ? element.fn : undefined;
  return element.kind === "loop" ? element.iterable : undefined;
}

/** Whether a value is the element itself. */
function isElement(value: Alt, element: Alt): boolean {
  if (value.kind === "parameter" && element.kind === "parameter")
    return value.fn === element.fn && value.index === element.index;
  return value.kind === "loop" && element.kind === "loop" && value.iterable === element.iterable;
}

/**
 * The questions about one file's paths, with the rule context fixed.
 *
 * @param context - The rule context.
 * @returns The path questions the rule asks.
 */
export function sourcePaths(context: Context) {
  /** The last name of each target a callee may name, one per alternative. */
  const lastNames = (callee: ESTree.Node): Array<string | undefined> =>
    calleeTargets(context, callee).map((target) => target?.path.at(-1));

  /** Whether any alternative of a callee is one of the named calls. */
  const callsOneOf = (callee: ESTree.Node, names: ReadonlySet<string>): boolean =>
    anyViolates(lastNames(callee), (name) => name !== undefined && names.has(name));

  /** Every spelling of each part, one list per part. */
  const partSpellings = (parts: ReadonlyArray<ESTree.Node | string>): Array<ReadonlyArray<PathSpelling>> =>
    parts.map((part) =>
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a template's literal chunk arrives as its text, an expression as its node
      typeof part === "string"
        ? [{ ...NOTHING, fragments: [part] }]
        : evaluate(context, part).flatMap((alternative) => spell(alternative))
    );

  /**
   * Every spelling of parts in order, one per combination of their spellings, with `temporary`
   * decided over the combination by how the parts combine.
   */
  const merge = (
    parts: ReadonlyArray<ESTree.Node | string>,
    temporaryOf: (combination: ReadonlyArray<PathSpelling>) => boolean
  ): PathSpelling[] =>
    product(
      partSpellings(parts),
      (combination) => [
        {
          fragments: combination.flatMap((spelling) => spelling.fragments),
          walked: combination.flatMap((spelling) => spelling.walked),
          temporary: temporaryOf(combination),
        },
      ],
      NOTHING
    );

  /** Joined segments stay under a temporary directory unless a later segment climbs out. */
  const joinedTemporary = (combination: ReadonlyArray<PathSpelling>): boolean => {
    const first = combination.findIndex((spelling) => spelling.temporary);
    return first >= 0 && !combination.slice(first + 1).some((spelling) => spelling.fragments.some(climbs));
  };

  /**
   * Resolved segments stay under a temporary directory only when every later segment is a known
   * relative one: an absolute segment, or one the rule cannot read, may drop it.
   */
  const resolvedTemporary = (combination: ReadonlyArray<PathSpelling>): boolean => {
    const last = combination.reduce((found, spelling, index) => (spelling.temporary ? index : found), -1);
    return (
      last >= 0 &&
      combination
        .slice(last + 1)
        .every(
          (spelling) =>
            spelling.walked.length === 0 &&
            spelling.fragments.length > 0 &&
            spelling.fragments.every((fragment) => !fragment.startsWith("/") && !climbs(fragment))
        )
    );
  };

  /** A string built from parts stays under a temporary directory when it starts with one. */
  const prefixTemporary = (combination: ReadonlyArray<PathSpelling>): boolean => {
    const lead = combination.find(
      (spelling) =>
        spelling.temporary || spelling.walked.length > 0 || spelling.fragments.some((text) => text !== "")
    );
    return lead?.temporary === true && joinedTemporary(combination);
  };

  /**
   * `new URL(spec, base)`: a spec with a scheme names its own file; an empty spec names the base;
   * any other spec names its own file in the base's directory, under a temporary base when it
   * climbs nowhere.
   */
  const urlSpellings = (spec: ESTree.Node | undefined, base: ESTree.Node | undefined): PathSpelling[] => {
    if (spec === undefined) return [NOTHING];
    const specs = partSpellings([spec]).flat();
    const bases = base === undefined ? [NOTHING] : partSpellings([base]).flat();
    return specs.flatMap((one) => {
      const text = one.fragments.join("");
      if (one.walked.length === 0 && text === "") return bases;
      if (ABSOLUTE_URL.test(text)) return [{ ...one, temporary: false }];
      return bases.map((under) => ({ ...one, temporary: under.temporary && !one.fragments.some(climbs) }));
    });
  };

  /** The spellings of an expression the evaluator keeps: one step of `SPELLINGS`. */
  const spellExpression = (expression: ESTree.Node): ReadonlyArray<PathSpelling> => {
    switch (expression.type) {
      case "TemplateLiteral":
        // The template's literal chunks stay in place between its computed parts.
        return merge(
          expression.quasis.flatMap((quasi, index) => {
            const text = staticText(quasi);
            const part = expression.expressions[index];
            return part === undefined ? [text] : [text, part];
          }),
          prefixTemporary
        );
      case "BinaryExpression":
        return expression.operator === "+"
          ? merge([expression.left, expression.right], prefixTemporary)
          : [NOTHING];
      case "CallExpression":
      case "NewExpression": {
        const callee = expression.callee;
        const [first, second] = expression.arguments;
        if (callsOneOf(callee, TEMP_DIRECTORIES)) return [{ ...NOTHING, temporary: true }];
        if (callsOneOf(callee, URL_CONSTRUCTOR)) return urlSpellings(first, second);
        if (callsOneOf(callee, CONVERTERS))
          return first === undefined ? [NOTHING] : partSpellings([first]).flat();
        if (callsOneOf(callee, RESOLVERS)) return merge(expression.arguments, resolvedTemporary);
        return callsOneOf(callee, JOINERS) ? merge(expression.arguments, joinedTemporary) : [NOTHING];
      }
      default:
        return [NOTHING];
    }
  };

  /**
   * The spellings of one path alternative: a string is its own fragment; a callback parameter or
   * a loop binding is walked, and so is a walked `Dirent`'s `.name`; a temporary directory, a template, a `+`, a path join, resolve or
   * conversion, or a `new URL` the evaluator kept is spelled from its parts.
   */
  const spell = (alternative: Alt): ReadonlyArray<PathSpelling> => {
    if (alternative.kind === "string") return [{ ...NOTHING, fragments: [alternative.value] }];
    if (alternative.kind === "parameter" || alternative.kind === "loop")
      return [{ ...NOTHING, walked: [alternative] }];
    // A walked `Dirent`'s `.name` is the walked file name; its `.parentPath` or `.path` names the
    // directory, which spells no file.
    if (
      alternative.kind === "member" &&
      (alternative.object.kind === "parameter" || alternative.object.kind === "loop")
    ) {
      if (alternative.key === "name") return [{ ...NOTHING, walked: [alternative.object] }];
      if (DIRENT_DIRECTORIES.has(alternative.key)) return [NOTHING];
    }
    if (alternative.kind !== "opaque") return [NOTHING];
    const expression = alternative.node;
    return SPELLINGS.run(
      context,
      expression,
      () => spellExpression(expression),
      () => [NOTHING]
    );
  };

  /** The strings a value is in every alternative, or `undefined` when one is not a string. */
  const stringsOf = (node: ESTree.Node): string[] | undefined => {
    const values = evaluate(context, node);
    const strings = stringValues(values);
    return strings.length === values.length ? strings : undefined;
  };

  /** The strings a complete array literal holds in every element, or `undefined`. */
  const elementStrings = (node: ESTree.Node): string[] | undefined => {
    const strings: string[] = [];
    for (const list of evaluate(context, node)) {
      if (list.kind !== "array" || !list.complete) return undefined;
      for (const element of list.elements) {
        const values = element === null ? undefined : stringsOf(element);
        if (values === undefined) return undefined;
        strings.push(...values);
      }
    }
    return strings;
  };

  /** The call a function is the element callback of, with that call's method and receiver. */
  const elementCallOf = (
    fn: ESTree.Node
  ): { readonly method: string; readonly receiver: ESTree.Node } | undefined => {
    const call = fn.parent;
    if (call?.type !== "CallExpression" || call.arguments[0] !== fn) return undefined;
    const callee = unwrap(call.callee);
    const method = memberName(callee);
    if (callee.type !== "MemberExpression" || method === undefined || !ELEMENT_CALLBACKS.has(method))
      return undefined;
    return { method, receiver: callee.object };
  };

  /** The element an element callback is handed: its first parameter. */
  const elementOf = (fn: ESTree.Node): Alt => plain({ kind: "parameter", fn, index: 0 });

  /**
   * Whether an expression is the element a selector tests, in every alternative, or a projection
   * that keeps its name: a member of it (`dirent.name`), a path built from it as the last segment
   * (`join(dir, name)`, `basename(name)`), a template that ends with it, or a case or trim of it.
   */
  const isSubject = (node: ESTree.Node, element: Alt): boolean => {
    const key = elementKey(element);
    if (key === undefined) return false;
    const expression = unwrap(node);
    return SUBJECTS.run(
      context,
      pairKey(expression, key),
      () =>
        evaluate(context, expression).every((value) => {
          if (isElement(value, element)) return true;
          if (value.kind === "member")
            return value.object.kind !== "unknown" && isElement(value.object, element);
          if (value.kind !== "opaque") return false;
          const kept = value.node;
          if (kept.type === "TemplateLiteral") {
            const last = kept.expressions.at(-1);
            const tail = kept.quasis.at(-1);
            return (
              tail !== undefined && staticText(tail) === "" && last !== undefined && isSubject(last, element)
            );
          }
          if (kept.type !== "CallExpression") return false;
          const callee = unwrap(kept.callee);
          const method = memberName(callee);
          if (callee.type === "MemberExpression" && method !== undefined && NAME_METHODS.has(method))
            return isSubject(callee.object, element);
          const last = kept.arguments.at(-1);
          return callsOneOf(kept.callee, NAME_KEEPERS) && last !== undefined && isSubject(last, element);
        }),
      () => false
    );
  };

  /**
   * The suffixes an `endsWith` argument may be: its strings, or, for the element parameter of a
   * `list.some((e) => …)` callback, every string the list holds.
   */
  const suffixesOf = (node: ESTree.Node): string[] | undefined => {
    const suffixes: string[] = [];
    for (const value of evaluate(context, node)) {
      if (value.kind === "string") {
        suffixes.push(value.value);
        continue;
      }
      const call = value.kind === "parameter" && value.index === 0 ? elementCallOf(value.fn) : undefined;
      const strings = call === undefined ? undefined : elementStrings(call.receiver);
      if (strings === undefined) return undefined;
      suffixes.push(...strings);
    }
    return suffixes;
  };

  /**
   * What an `endsWith` argument keeps: what its suffixes name, or, for a helper's own parameter
   * (`function list(ext) { … n.endsWith(ext) … }`), what every call site passes when every site
   * keeps the same. Sites that disagree (`list(".ts")` and `list(".json")`) prove nothing, since one
   * listing serves both. One step of `SUFFIXES` per argument.
   */
  const selectionOfSuffix = (node: ESTree.Node): Selection =>
    SUFFIXES.run(
      context,
      node,
      () => {
        const suffixes = suffixesOf(node);
        if (suffixes !== undefined) return selectionOfNames(suffixes);
        const values = evaluate(context, node);
        const [parameter] = values;
        if (
          values.length !== 1 ||
          parameter?.kind !== "parameter" ||
          elementCallOf(parameter.fn) !== undefined
        )
          return "any";
        const sites = callSitesOf(context, parameter.fn).map((site): Selection => {
          const passed = site.arguments.slice(0, parameter.index + 1);
          const argument = site.arguments[parameter.index];
          if (argument === undefined || passed.some((one) => one.type === "SpreadElement")) return "any";
          return selectionOfSuffix(argument);
        });
        const [agreed] = sites;
        return agreed !== undefined && sites.every((one) => one === agreed) ? agreed : "any";
      },
      () => "any"
    );

  /**
   * What a regular expression keeps when it tests a file name, by the sample names it matches:
   * code when it matches a code file name and no other kind, other when it matches only other
   * kinds, and nothing provable when it matches both (`/.*\/`) or does not compile. It falls back
   * to `selectionOfEndings` when no sample name matches, such as for a pattern with a stem
   * (`/button\.tsx?$/`).
   */
  const selectionOfPattern = (node: ESTree.Node): Selection =>
    joined(
      evaluate(context, node).map((pattern): Selection => {
        if (pattern.kind !== "regex") return "any";
        let regex: RegExp;
        try {
          regex = new RegExp(pattern.pattern, pattern.flags.replace(/[gy]/gu, ""));
        } catch {
          return "any";
        }
        const code = CODE_SAMPLES.some((name) => regex.test(name));
        const other = OTHER_SAMPLES.some((name) => regex.test(name));
        if (code && other) return "any";
        if (code) return "code";
        return other ? "other" : selectionOfEndings(regex);
      })
    ) ?? "any";

  /** The argument of an `extname(…)` call, or `undefined` for anything else. */
  const extnameOf = (node: ESTree.Node): ESTree.Node | undefined => {
    const expression = unwrap(node);
    return expression.type === "CallExpression" && callsOneOf(expression.callee, EXTNAME)
      ? expression.arguments[0]
      : undefined;
  };

  /** What the tests a callback returns keep, each judged against an element. */
  const selectionOfCallback = (
    node: ESTree.Node | undefined,
    elementFor: (fn: ESTree.Node) => Alt
  ): Selection => {
    if (node === undefined) return "any";
    const selections = evaluate(context, node).flatMap((callback): Selection[] =>
      callback.kind === "function"
        ? returnedValues(context, callback.fn).map((returned) =>
            selectionOfTest(returned, elementFor(callback.fn))
          )
        : ["any"]
    );
    return joined(selections) ?? "any";
  };

  /**
   * What a test on the element keeps, by the positive selectors the rule recognises, each only
   * when what it inspects is the element or a projection of it: `&&` both, `||` either, and
   * anything negated or unrecognised nothing provable. One step of `TESTS`.
   */
  const selectionOfTest = (node: ESTree.Node, element: Alt): Selection => {
    const expression = unwrap(node);
    const key = elementKey(element);
    if (key === undefined) return "any";
    return TESTS.run(
      context,
      pairKey(expression, key),
      () => testSelection(expression, element),
      () => "any"
    );
  };

  /** The body of `selectionOfTest`. */
  const testSelection = (expression: ESTree.Node, element: Alt): Selection => {
    switch (expression.type) {
      case "LogicalExpression":
        if (expression.operator === "&&")
          return both(selectionOfTest(expression.left, element), selectionOfTest(expression.right, element));
        if (expression.operator === "||")
          return either(
            selectionOfTest(expression.left, element),
            selectionOfTest(expression.right, element)
          );
        return "any";
      case "BinaryExpression": {
        if (expression.operator !== "===" && expression.operator !== "==") return "any";
        const [inspected, extension] =
          extnameOf(expression.left) === undefined
            ? [extnameOf(expression.right), expression.left]
            : [extnameOf(expression.left), expression.right];
        if (inspected === undefined || !isSubject(inspected, element)) return "any";
        const strings = stringsOf(extension);
        return strings === undefined ? "any" : selectionOfNames(strings);
      }
      case "CallExpression": {
        const callee = unwrap(expression.callee);
        const method = memberName(callee);
        const [first] = expression.arguments;
        if (callee.type !== "MemberExpression" || method === undefined) return "any";
        if (method === "endsWith" && first !== undefined && isSubject(callee.object, element))
          return selectionOfSuffix(first);
        if (method === "test" && first !== undefined && isSubject(first, element))
          return selectionOfPattern(callee.object);
        if (method === "match" && first !== undefined && isSubject(callee.object, element))
          return selectionOfPattern(first);
        const inspected = first === undefined ? undefined : extnameOf(first);
        if (method === "includes" && inspected !== undefined && isSubject(inspected, element)) {
          const strings = elementStrings(callee.object);
          return strings === undefined ? "any" : selectionOfNames(strings);
        }
        // `LIST.some((e) => name.endsWith(e))` still tests the outer element.
        if (SOME_STEPS.has(method)) return selectionOfCallback(first, () => element);
        return "any";
      }
      default:
        return "any";
    }
  };

  /** What the guards between a node and the code around it keep: each `if` it runs under the consequent of. */
  const guardsOf = (node: ESTree.Node, around: ESTree.Node, element: Alt): Selection => {
    let selection: Selection = "any";
    for (let child = node, parent = node.parent; parent !== null && child !== around;) {
      if (parent.type === "IfStatement" && parent.consequent === child)
        selection = both(selection, selectionOfTest(parent.test, element));
      if (parent.type === "LogicalExpression" && parent.operator === "&&" && parent.right === child)
        selection = both(selection, selectionOfTest(parent.left, element));
      if (parent.type === "ConditionalExpression" && parent.consequent === child)
        selection = both(selection, selectionOfTest(parent.test, element));
      child = parent;
      parent = parent.parent;
    }
    return selection;
  };

  /**
   * Whether a mapping callback returns the name it is handed, or a projection that keeps it; when
   * the step `flattens` (`flatMap`), each element of an array literal it returns is judged instead
   * (`(f) => [f]`), and a hole or a spread in one keeps nothing provable.
   */
  const keepsName = (fn: ESTree.Node, flattens: boolean): boolean => {
    const returned = returnedValues(context, fn).flatMap((value): Array<ESTree.Node | null> => {
      const expression = unwrap(value);
      return flattens && expression.type === "ArrayExpression" ? expression.elements : [value];
    });
    return (
      returned.length > 0 &&
      returned.every(
        (value) => value !== null && value.type !== "SpreadElement" && isSubject(value, elementOf(fn))
      )
    );
  };

  /**
   * What one element written or pushed into a list keeps, judged where it is written: a path is
   * code or other by its spelling, else by the values it walks (`join(dir, name)`), as
   * `spellsCode` judges a read: code when any walked value keeps code, other only when every one
   * provably keeps other.
   */
  const selectionOfElement = (node: ESTree.Node, at: ESTree.Node): Selection | undefined =>
    joined(
      evaluate(context, node).flatMap((alternative) =>
        spell(alternative).map((spelling): Selection | undefined => {
          const named = namedSelection(spelling);
          if (named !== undefined) return named;
          const walked = spelling.walked.map((value) => selectionOfWalked(value, at));
          if (walked.includes("code")) return "code";
          return walked.length > 0 && walked.every((kept) => kept === "other") ? "other" : undefined;
        })
      )
    );

  /** Whether a change in place only reorders a list (`sort`, `reverse`), keeping what it holds. */
  const permutes = (site: ESTree.Node): boolean =>
    site.type === "CallExpression" && PERMUTING.has(memberName(unwrap(site.callee)) ?? "");

  /**
   * What a list literal and what is pushed into it keep. A spread, written in the literal
   * (`[...xs]`) or pushed (`push(...xs)`), appends every name the spread list holds. A sort or
   * reverse in place keeps them; any other change in place leaves the list unprovable.
   */
  const literalSelection = (node: ESTree.ArrayExpression): Selection | undefined => {
    const pushes: Array<Extract<Mutation, { readonly kind: "push" }>> = [];
    for (const mutation of mutationsOf(context, node)) {
      if (mutation.kind === "push") pushes.push(mutation);
      else if (!permutes(mutation.site)) return undefined;
    }
    let selection: Selection = "other";
    const spreads = [
      ...node.elements.flatMap((element) => (element?.type === "SpreadElement" ? [element.argument] : [])),
      ...pushes.flatMap((push) => push.spreads),
    ];
    // A spread of this list itself (a recursive walker's `out.push(...walk(sub))`) adds nothing it
    // does not already hold.
    for (const list of spreads) {
      const values = evaluate(context, list);
      if (values.length > 0 && values.every((value) => value.kind === "array" && value.node === node))
        continue;
      const kept = selectionOfList(list);
      if (kept === undefined) return undefined;
      selection = either(selection, kept);
    }
    const elements = [
      ...node.elements.flatMap((element) =>
        element === null || element.type === "SpreadElement" ? [] : [{ node: element, at: element }]
      ),
      ...pushes.flatMap((push) => push.values.map((value) => ({ node: value, at: push.site }))),
    ];
    for (const element of elements) {
      const kept = selectionOfElement(element.node, element.at);
      if (kept === undefined) return undefined;
      selection = either(selection, kept);
    }
    return selection;
  };

  /** What a listing or an array step on a list keeps: the body of one `LISTS` step for a call. */
  const callSelection = (call: ESTree.CallExpression): Selection | undefined => {
    const [first] = call.arguments;
    if (callsOneOf(call.callee, GLOB_LISTINGS)) {
      const patterns = first === undefined ? undefined : (stringsOf(first) ?? elementStrings(first));
      const positive = (patterns ?? []).filter((pattern) => !pattern.startsWith("!"));
      if (patterns === undefined || positive.length === 0) return "any";
      if (positive.some((pattern) => CODE_GLOB.test(pattern) || CODE_FILE.test(pattern))) return "code";
      return positive.every((pattern) => EXTENSION.test(pattern)) ? "other" : "any";
    }
    if (callsOneOf(call.callee, DIRECTORY_LISTINGS)) return "any";
    const callee = unwrap(call.callee);
    const method = memberName(callee);
    if (callee.type !== "MemberExpression" || method === undefined) return undefined;
    const receiver = selectionOfList(callee.object);
    if (receiver === undefined) return undefined;
    if (method === "filter") return both(receiver, selectionOfCallback(first, elementOf));
    if (KEEPING_STEPS.has(method)) return receiver;
    if (method === "concat") {
      return call.arguments.reduce<Selection>(
        (selection, argument) => either(selection, selectionOfList(argument) ?? "any"),
        receiver
      );
    }
    if (MAPPING_STEPS.has(method) && first !== undefined) {
      const callbacks = evaluate(context, first);
      return callbacks.every(
        (callback) => callback.kind === "function" && keepsName(callback.fn, method === "flatMap")
      )
        ? receiver
        : undefined;
    }
    return undefined;
  };

  /**
   * What a list expression keeps, `code` when any alternative keeps code, or `undefined` for a
   * value that is no list the rule can follow: a listing, an array step on one, or an array
   * literal with what it spreads and what is pushed into it.
   */
  const selectionOfList = (node: ESTree.Node): Selection | undefined => {
    const expression = unwrap(node);
    return LISTS.run(
      context,
      expression,
      () => {
        // Each combination of a literal's spreads is one alternative; the literal is judged once.
        const literals = new Map<ESTree.Node, Selection | undefined>();
        return joined(
          evaluate(context, expression).map((alternative) => {
            if (alternative.kind === "array") {
              if (!literals.has(alternative.node))
                literals.set(alternative.node, literalSelection(alternative.node));
              return literals.get(alternative.node);
            }
            if (alternative.kind !== "opaque" || alternative.node.type !== "CallExpression") return undefined;
            return callSelection(alternative.node);
          })
        );
      },
      () => undefined
    );
  };

  /**
   * What a walked value keeps where it is used (`at`): a loop binding keeps what its iterable
   * keeps and what the guards between the loop and `at` keep; an element callback's parameter,
   * what the receiver keeps and the callback's guards.
   */
  const selectionOfWalked = (value: Alt, at: ESTree.Node): Selection | undefined => {
    if (value.kind === "loop") {
      const loop = value.iterable.parent;
      const kept = selectionOfList(value.iterable);
      return kept === undefined || loop === null ? undefined : both(kept, guardsOf(at, loop, value));
    }
    if (value.kind !== "parameter" || value.index !== 0) return undefined;
    const call = elementCallOf(value.fn);
    if (call === undefined) return undefined;
    const kept = selectionOfList(call.receiver);
    return kept === undefined ? undefined : both(kept, guardsOf(at, value.fn, value));
  };

  /**
   * Every identity a path expression may be written as: a string, a value the evaluator keeps,
   * and, for a writer helper's parameter, what each of its call sites passes.
   */
  const writtenAs = (node: ESTree.Node): ReadonlySet<Identity> => {
    const expression = unwrap(node);
    return WRITTEN.run(
      context,
      expression,
      () =>
        new Set(
          evaluate(context, expression).flatMap((value): Identity[] => {
            if (value.kind === "string") return [`string:${value.value}`];
            if (value.kind === "opaque") return [value.node];
            if (value.kind !== "parameter") return [];
            return callSitesOf(context, value.fn).flatMap((site) => {
              const argument = site.arguments[value.index];
              return argument === undefined ? [] : [...writtenAs(argument)];
            });
          })
        ),
      () => new Set()
    );
  };

  /** Every identity the file writes a path as, built once per file. */
  const writtenPaths = (): ReadonlySet<Identity> => {
    const program = context.sourceCode.ast;
    const known = WRITTEN_BY_FILE.get(program);
    if (known !== undefined) return known;
    const found = isolated(
      () =>
        new Set(
          descendants(context, program, "into-functions").flatMap((node) => {
            if (node.type !== "CallExpression" || !callsOneOf(node.callee, WRITES)) return [];
            const [target] = node.arguments;
            return target === undefined ? [] : [...writtenAs(target)];
          })
        )
    );
    WRITTEN_BY_FILE.set(program, found);
    return found;
  };

  /**
   * Whether the file writes the path a read reads: every alternative is a string or a kept value
   * some write in the file targets. A helper's parameter is matched at each call site instead.
   */
  const isWrittenByTest = (node: ESTree.Node): boolean =>
    evaluate(context, node).every((value) => {
      if (value.kind === "string") return writtenPaths().has(`string:${value.value}`);
      return value.kind === "opaque" && writtenPaths().has(value.node);
    });

  /** Whether one spelling names a code module where it is read: by its last named file, or by the list it walks. */
  const spellsCode = (spelling: PathSpelling, at: ESTree.Node): boolean => {
    const named = namedSelection(spelling);
    if (named !== undefined) return named === "code";
    return spelling.walked.some((value) => {
      if (selectionOfWalked(value, at) === "code") return true;
      // A reader helper's parameter is judged at each call site, against what that site passes.
      if (value.kind !== "parameter" || elementCallOf(value.fn) !== undefined) return false;
      return callSitesOf(context, value.fn).some((site) => {
        const argument = site.arguments[value.index];
        return argument !== undefined && !isWrittenByTest(argument) && isCodePath(argument, site);
      });
    });
  };

  /**
   * Whether a path read at `at` may name a code module: any alternative's spelling does. One step
   * of `CODE_PATHS` per path and point.
   *
   * @param node - The path expression.
   * @param at - Where it is read: the read, or a helper's call site.
   * @returns Whether it may name a code module.
   */
  const isCodePath = (node: ESTree.Node, at: ESTree.Node): boolean =>
    CODE_PATHS.run(
      context,
      pairKey(unwrap(node), at),
      () =>
        anyViolates(evaluate(context, node), (alternative) =>
          anyViolates(spell(alternative), (spelling) => spellsCode(spelling, at))
        ),
      () => false
    );

  return { isCodePath, isWrittenByTest, callsOneOf };
}
