import { defineRule } from "@oxlint/plugins";

import type { ESTree, Options, SourceCode } from "@oxlint/plugins";

import {
  commentRemovalRange,
  createSlopCommentSkipper,
  dividerPattern,
  hasTrackerOrRfcReference,
  isStandaloneLineComment,
} from "../shared/slop-comments.ts";

const framedLabelPattern = /^[=\-~#*]{2,}[^=\-~#*]+[=\-~#*]{2,}$/u;

function isBanner(value: string): boolean {
  const trimmed = value.trim();
  return dividerPattern.test(trimmed) || framedLabelPattern.test(trimmed);
}

const todoMarkerPattern = /\b(?:TODO|FIXME)\b/iu;
const uppercaseMarkerPattern = /\b(?:HACK|XXX)\b/u;

const uppercasePanicPattern = /\bIMPORTANT\b/u;
const phrasePanicPattern =
  /\bdo not (?:remove|change|touch|delete|modify)\b|\btoo risky\b|\bfine for now\b/iu;

function isPanic(value: string): boolean {
  return uppercasePanicPattern.test(value) || phrasePanicPattern.test(value);
}

function commentContentLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.replace(/^\s*\*+\s?/u, "").trim())
    .filter((line) => line.length > 0);
}

// Statement and JSX shapes only. Bare ";" / "{" match ordinary prose, so they are not
// evidence on their own; a multi-line corpse must also show braces or a closer line.
const strongCodeLinePatterns = [
  /^(?:const|let|var)\s+\w+\s*[=:]/u,
  /^(?:let|var)\s+[A-Za-z_$][\w$]*\s*;$/u,
  /^(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\s*(?:\?\?=|&&=|\|\|=|\+=|-=|\*=|\/=|=(?!=|>))\s*\S.*;$/u,
  /^import\b.*\bfrom\s+["']/u,
  /^export\s+(?:default\s|const\s+\w+\s*=|function\b|class\b|type\b|interface\b|\{)/u,
  /^(?:function|class|type|interface|enum)\s+\w/u,
  /^(?:if|for|while|switch)\s*\(.*[;{)]$/u,
  /^(?:return|await)\s+[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*;$/u,
  /^throw\s+(?:new\s+)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\([^()]*\))?;$/u,
  /^console\.\w+\(/u,
  /^\}\s*else\b/u,
  /=>\s*[{(]?\s*$/u,
  /^<\/?[A-Z]/u,
  /\/>;?$/u,
  /^<\/?\w+[^<>]*>;?$/u,
];

const closerLinePattern = /^[})\]]+[;,]?$/u;

function isStrongCodeLine(line: string): boolean {
  return strongCodeLinePatterns.some((pattern) => pattern.test(line));
}

function isBalancedCallBlock(lines: string[]): boolean {
  const first = lines.at(0) ?? "";
  const last = lines.at(-1) ?? "";
  if (
    !/^(?:(?:return|await)\s+)?(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\s*\(/u.test(
      first,
    ) ||
    !/\)\s*;$/u.test(last)
  ) {
    return false;
  }

  const openers: string[] = [];
  for (const character of lines.join("\n")) {
    if (character === "(" || character === "[" || character === "{") {
      openers.push(character);
    } else if (character === ")" || character === "]" || character === "}") {
      const expected = character === ")" ? "(" : character === "]" ? "[" : "{";
      if (openers.pop() !== expected) return false;
    }
  }
  return openers.length === 0;
}

function isCommentedOutCode(value: string): boolean {
  const lines = commentContentLines(value);
  if (lines.length === 0) return false;

  if (isBalancedCallBlock(lines)) return true;

  const strongCount = lines.filter((line) => isStrongCodeLine(line)).length;
  if (lines.length === 1) return strongCount === 1;

  if (strongCount >= 2) return true;
  if (strongCount === 0) return false;

  const joined = lines.join("\n");
  return (
    closerLinePattern.test(lines.at(-1) ?? "") ||
    /\{[\s\S]*\}/u.test(joined) ||
    /\[[\s\S]*\]/u.test(joined)
  );
}

function areAdjacentLineComments(
  sourceCode: SourceCode,
  previous: ESTree.Comment,
  next: ESTree.Comment,
): boolean {
  return (
    isStandaloneLineComment(sourceCode, previous) &&
    isStandaloneLineComment(sourceCode, next) &&
    next.loc.start.line === previous.loc.end.line + 1
  );
}

/** Partition comments into runs of standalone `//` comments on consecutive lines. */
function groupAdjacentLineComments(
  sourceCode: SourceCode,
  comments: ESTree.Comment[],
): ESTree.Comment[][] {
  const groups: ESTree.Comment[][] = [];
  let current: ESTree.Comment[] = [];
  let previous: ESTree.Comment | undefined;
  for (const comment of comments) {
    if (previous !== undefined && areAdjacentLineComments(sourceCode, previous, comment)) {
      current.push(comment);
    } else {
      if (current.length > 0) groups.push(current);
      current = [comment];
    }
    previous = comment;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

const defaultTicketPattern = "[A-Z][A-Z0-9]*-\\d+";

type TicketPatternOption = { ticketPattern: string };

function ticketPatternOf(options: Readonly<Options>): RegExp {
  // SAFETY: `meta.defaultOptions` and the schema `default` always supply `ticketPattern`.
  const option = options[0] as TicketPatternOption;
  return new RegExp(`\\b(?:${option.ticketPattern})\\b`, "u");
}

type SlopMessageId = "bannerComment" | "commentedOutCode" | "panicComment" | "todoWithoutLink";

/** Reject comment shapes that are recognizable slop: banners, corpses, panic prose, unlinked TODOs. */
export const noSlopCommentsRule = defineRule({
  meta: {
    type: "suggestion",
    hasSuggestions: true,
    docs: {
      description:
        "Disallow slop comments: banners, commented-out code, panic vocabulary, and TODOs without a tracker or RFC reference.",
    },
    messages: {
      bannerComment:
        "Banner and divider comments add no information. Delete the banner; if the file needs sections, split it.",
      commentedOutCode:
        "Commented-out code is a corpse; version control already remembers it. Delete it.",
      panicComment:
        "Panic prose does not protect anything. Encode the constraint as a type, test, or lint rule, then delete the comment.",
      todoWithoutLink:
        "A TODO, FIXME, HACK, or XXX without a tracker or RFC reference is a wish, not a plan. Add a reference or delete it.",
      removeComment: "Delete this comment.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ticketPattern: { type: "string", default: defaultTicketPattern },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ ticketPattern: defaultTicketPattern }],
  },
  createOnce(context) {
    const report = (comments: ESTree.Comment[], messageId: SlopMessageId) => {
      const first = comments.at(0);
      const last = comments.at(-1);
      if (first === undefined || last === undefined) return;
      const [start] = commentRemovalRange(context.sourceCode, first);
      const [, end] = commentRemovalRange(context.sourceCode, last);
      context.report({
        loc: { start: first.loc.start, end: last.loc.end },
        messageId,
        suggest: [{ messageId: "removeComment", fix: (fixer) => fixer.removeRange([start, end]) }],
      });
    };

    const reportSingle = (comment: ESTree.Comment, ticketPattern: RegExp) => {
      if (isBanner(comment.value)) {
        report([comment], "bannerComment");
      } else if (isCommentedOutCode(comment.value)) {
        report([comment], "commentedOutCode");
      } else if (isPanic(comment.value)) {
        report([comment], "panicComment");
      } else if (
        (todoMarkerPattern.test(comment.value) || uppercaseMarkerPattern.test(comment.value)) &&
        !hasTrackerOrRfcReference(comment.value, ticketPattern)
      ) {
        report([comment], "todoWithoutLink");
      }
    };

    return {
      Program() {
        const shouldSkip = createSlopCommentSkipper(context.sourceCode);
        const ticketPattern = ticketPatternOf(context.options);
        const comments = context.sourceCode.getAllComments().filter((c) => !shouldSkip(c));
        for (const group of groupAdjacentLineComments(context.sourceCode, comments)) {
          const value = group.map((candidate) => candidate.value).join("\n");
          if (group.length > 1 && isCommentedOutCode(value)) {
            report(group, "commentedOutCode");
          } else {
            for (const candidate of group) reportSingle(candidate, ticketPattern);
          }
        }
      },
    };
  },
});
