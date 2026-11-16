/**
 * The endings a regular expression requires of a string it matches, read from its source: the run
 * of pieces before a final `$` (`button\.tsx?$`, `^index\.(ts|tsx)$`, `\.[cm]?[jt]sx?$`), expanded
 * to every string it spells, so every match ends with one of them. Reading follows the syntax only.
 *
 * - A piece that is not a finite set of strings ends the run: `^`, a wildcard, an escape class
 *   (`\w`), a class that is negated or holds a range, a repetition, a lookaround, or a group that
 *   is not a plain or `(?:` group.
 * - Reading returns `undefined` when there is no final `$`, the `m` flag is set, there is a
 *   top-level `|`, the run is empty, a `$` is inside the run, the run spells more than
 *   `MAX_ENDINGS` strings, groups nest deeper than `MAX_DEPTH`, or it meets an escape with a
 *   payload (`\x`, `\u`, `\c`, `\k`, `\p`, `\P`, `\q`, a digit) or a `[` inside a class.
 * - Under the `i` flag the endings are lower-cased.
 */

/** The most endings a pattern may spell before it counts as unreadable. */
const MAX_ENDINGS = 64;

/** The deepest group nesting the reader follows; deeper is unreadable. */
const MAX_DEPTH = 32;

/** The escapes followed by a payload the reader does not decode. */
const PAYLOAD_ESCAPES = /[xuckpPq0-9]/u;

/** One piece of a pattern: the strings it spells, an anchor, or `undefined` for one it cannot spell. */
type Piece = ReadonlyArray<string> | "start" | "end" | undefined;

/** A parse position and what was read up to it. */
type Parsed<T> = { readonly value: T; readonly next: number };

/** Where a group's body starts, and whether its text is spelled. */
type Group = { readonly body: number; readonly spells: boolean };

/** Whether a piece spells a finite set of strings. */
function isStrings(piece: Piece): piece is ReadonlyArray<string> {
  return piece !== undefined && piece !== "start" && piece !== "end";
}

/** Every concatenation of one string from each list, or `undefined` past the cap. */
function product(lists: ReadonlyArray<ReadonlyArray<string>>): string[] | undefined {
  let strings = [""];
  for (const list of lists) {
    strings = strings.flatMap((prefix) => list.map((part) => prefix + part));
    if (strings.length > MAX_ENDINGS) return undefined;
  }
  return strings;
}

/** The strings a sequence of pieces spells, or `undefined` when one piece is not a finite set of strings. */
function spelled(pieces: ReadonlyArray<Piece>): string[] | undefined {
  return pieces.every(isStrings) ? product(pieces) : undefined;
}

/**
 * The characters a class `[…]` starting at `start` holds, when they are plain word characters or
 * escaped punctuation; `undefined` for a payload escape or a nested `[`.
 */
function readClass(source: string, start: number): Parsed<Piece> | undefined {
  const characters = new Set<string>();
  let readable = source[start + 1] !== "^";
  for (let index = start + 1; index < source.length; index++) {
    const character = source[index];
    if (character === "]") return { value: readable ? [...characters] : undefined, next: index + 1 };
    if (character === "[") return undefined;
    if (character === "\\") {
      const escaped = source[index + 1];
      if (escaped === undefined || PAYLOAD_ESCAPES.test(escaped)) return undefined;
      if (/[A-Za-z]/u.test(escaped)) readable = false;
      else characters.add(escaped);
      index++;
      continue;
    }
    if (character === undefined || !/[A-Za-z0-9_.]/u.test(character)) readable = false;
    else characters.add(character);
  }
  return undefined;
}

/** Where a group's body starts, and whether the group's text is spelled: plain and `(?:` groups only. */
function groupBody(source: string, start: number): Group {
  if (source.startsWith("(?:", start)) return { body: start + 3, spells: true };
  if (source.startsWith("(?<=", start) || source.startsWith("(?<!", start))
    return { body: start + 4, spells: false };
  if (source.startsWith("(?=", start) || source.startsWith("(?!", start))
    return { body: start + 3, spells: false };
  if (source.startsWith("(?<", start)) {
    const close = source.indexOf(">", start);
    return { body: close === -1 ? source.length : close + 1, spells: false };
  }
  return { body: start + 1, spells: source[start + 1] !== "?" };
}

/**
 * Read alternatives from `start` up to the end, or, inside a group (`depth` above zero), up to the
 * `)` that closes it. Syntax recursion only, at most `MAX_DEPTH` groups deep.
 */
function readAlternatives(
  source: string,
  start: number,
  depth: number
): Parsed<Array<Array<Piece>>> | undefined {
  if (depth > MAX_DEPTH) return undefined;
  const alternatives: Array<Array<Piece>> = [[]];
  let index = start;
  let quantified = false;
  while (index < source.length) {
    const character = source[index];
    const pieces = alternatives.at(-1) ?? [];
    const wasQuantified = quantified;
    quantified = false;
    switch (character) {
      case ")":
        return depth > 0 ? { value: alternatives, next: index + 1 } : undefined;
      case "|":
        alternatives.push([]);
        index++;
        break;
      case "\\": {
        const escaped = source[index + 1];
        if (escaped === undefined || PAYLOAD_ESCAPES.test(escaped)) return undefined;
        pieces.push(/[A-Za-z]/u.test(escaped) ? undefined : [escaped]);
        index += 2;
        break;
      }
      case "[": {
        const read = readClass(source, index);
        if (read === undefined) return undefined;
        pieces.push(read.value);
        index = read.next;
        break;
      }
      case "(": {
        const { body, spells } = groupBody(source, index);
        const read = readAlternatives(source, body, depth + 1);
        if (read === undefined) return undefined;
        const strings = read.value.map(spelled);
        pieces.push(
          spells && strings.every((one) => one !== undefined) ? product([strings.flat()]) : undefined
        );
        index = read.next;
        break;
      }
      case "^":
        pieces.push("start");
        index++;
        break;
      case "$":
        pieces.push("end");
        index++;
        break;
      case "?": {
        // `x??` is `x?` matched lazily: the same strings.
        if (!wasQuantified) {
          const previous = pieces.pop();
          pieces.push(isStrings(previous) ? [...previous, ""] : undefined);
        }
        quantified = true;
        index++;
        break;
      }
      case "*":
      case "+":
      case "{": {
        pieces.pop();
        pieces.push(undefined);
        quantified = true;
        const close = character === "{" ? source.indexOf("}", index) : index;
        index = close === -1 ? source.length : close + 1;
        break;
      }
      case ".":
        pieces.push(undefined);
        index++;
        break;
      default:
        pieces.push(character === undefined ? undefined : [character]);
        index++;
    }
  }
  return depth > 0 ? undefined : { value: alternatives, next: index };
}

/**
 * The endings every string a pattern matches ends with, as this module describes.
 *
 * @param pattern - The regular expression's source.
 * @param flags - Its flags.
 * @returns The endings, lower-cased under the `i` flag, or `undefined` when they cannot be read.
 */
export function endingsOf(pattern: string, flags: string): ReadonlyArray<string> | undefined {
  if (flags.includes("m")) return undefined;
  const read = readAlternatives(pattern, 0, 0);
  const [pieces, ...others] = read?.value ?? [];
  if (pieces === undefined || others.length > 0 || pieces.at(-1) !== "end") return undefined;
  const run: Piece[] = [];
  for (const piece of pieces.slice(0, -1).reverse()) {
    if (piece === undefined || piece === "start") break;
    if (piece === "end") return undefined;
    run.unshift(piece);
  }
  const endings = run.length === 0 ? undefined : spelled(run);
  return flags.includes("i") ? endings?.map((ending) => ending.toLowerCase()) : endings;
}
