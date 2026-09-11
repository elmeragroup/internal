import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

import {
  commentRemovalRange,
  createSlopCommentSkipper,
  isSafeCommentRemoval,
  isStandaloneLineComment,
} from "../shared/slop-comments.ts";

const narrationStopwords = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "in",
  "is",
  "it",
  "now",
  "of",
  "on",
  "or",
  "that",
  "the",
  "then",
  "this",
  "to",
  "we",
  "with",
]);

function splitIdentifierWords(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[\s_$]+/u)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 0);
}

/** Lowercase words of every identifier-shaped token, camelCase and snake_case split apart. */
function wordsOf(text: string): string[] {
  return (text.match(/[A-Za-z_$][A-Za-z0-9_$]*/gu) ?? []).flatMap(splitIdentifierWords);
}

/** The first line after the comment that is not another `//` comment; undefined at a blank line or EOF. */
function nextCodeLine(sourceCode: SourceCode, comment: ESTree.Comment): string | undefined {
  for (let index = comment.loc.end.line; index < sourceCode.lines.length; index += 1) {
    const line = sourceCode.lines[index];
    if (line === undefined || line.trim() === "") return undefined;
    if (!line.trimStart().startsWith("//")) return line;
  }
  return undefined;
}

function isNarration(sourceCode: SourceCode, comment: ESTree.Comment): boolean {
  if (!isStandaloneLineComment(sourceCode, comment)) return false;
  const codeLine = nextCodeLine(sourceCode, comment);
  if (codeLine === undefined) return false;

  const contentWords = wordsOf(comment.value).filter((word) => !narrationStopwords.has(word));
  if (contentWords.length < 2) return false;

  const codeWords = new Set(wordsOf(codeLine));
  return contentWords.every((word) => codeWords.has(word));
}

/** Reject line comments that restate the next statement. */
export const noNarrationCommentsRule = defineRule({
  meta: {
    type: "suggestion",
    hasSuggestions: true,
    docs: {
      description:
        "Disallow line comments that restate the next statement instead of explaining a constraint the code cannot.",
    },
    messages: {
      narrationComment:
        "This comment restates the code below it. Delete it; the code already says this.",
      removeComment: "Delete this comment.",
    },
  },
  createOnce(context) {
    return {
      Program() {
        const shouldSkip = createSlopCommentSkipper(context.sourceCode);
        for (const comment of context.sourceCode.getAllComments()) {
          if (shouldSkip(comment)) continue;
          if (!isNarration(context.sourceCode, comment)) continue;
          const range = commentRemovalRange(context.sourceCode, comment);
          // Line comments always pass; isNarration never reports a block, so suggest is never empty.
          const safe = isSafeCommentRemoval(context.sourceCode, comment);
          context.report({
            loc: comment.loc,
            messageId: "narrationComment",
            suggest: safe
              ? [{ messageId: "removeComment", fix: (fixer) => fixer.removeRange(range) }]
              : [],
          });
        }
      },
    };
  },
});
