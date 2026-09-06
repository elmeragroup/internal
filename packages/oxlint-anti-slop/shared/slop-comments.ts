import type { ESTree, SourceCode } from "@oxlint/plugins";

const directivePattern =
  /^\s*(?:oxlint-|eslint-|@ts-(?:ignore|expect-error|nocheck|check)\b|prettier-ignore\b|biome-ignore\b|v8 ignore\b|istanbul ignore\b|@vite-ignore\b|@jsx|#__PURE__|@__NO_SIDE_EFFECTS__|\/ <reference|webpack[A-Za-z]+:)/u;
const safetyPattern = /^\s*SAFETY\s*:/u;
const licenseHeaderPattern =
  /\bSPDX-License-Identifier\b|\bCopyright\b|\bLicensed under\b|\bMIT License\b|@license\b/iu;
const licenseHeaderPanicPattern = /^\s*DO NOT REMOVE THIS HEADER\s*$/iu;

/** A comment made only of divider characters: `// -----`, `/* ***** *\/`, `// ====`. */
export const dividerPattern = /^[=\-~_#*/\s]{4,}$/u;

/**
 * The comments of the file's leading comment group that are license text, the
 * `DO NOT REMOVE THIS HEADER` line, or a divider. Empty unless the group holds a
 * license marker; a stray comment inside the group (say a corpse) is never included.
 */
function leadingLicenseHeaderComments(sourceCode: SourceCode): ESTree.Comment[] {
  const comments = sourceCode.getAllComments();
  const first = comments.at(0);
  if (first === undefined) return [];

  const prefix = sourceCode.text
    .slice(0, first.start)
    .replace(/^#![^\r\n]*(?:\r\n|\n|\r)?/u, "");
  if (prefix.trim() !== "") return [];

  const leadingGroup = [first];
  let previousEnd = first.end;
  for (const next of comments.slice(1)) {
    const gap = sourceCode.text.slice(previousEnd, next.start);
    const lineBreakCount = gap.match(/\r\n|\r|\n/gu)?.length ?? 0;
    if (gap.trim() !== "" || lineBreakCount > 1) break;
    leadingGroup.push(next);
    previousEnd = next.end;
  }

  if (!leadingGroup.some((candidate) => licenseHeaderPattern.test(candidate.value))) return [];
  return leadingGroup.filter(
    (candidate) =>
      licenseHeaderPattern.test(candidate.value) ||
      licenseHeaderPanicPattern.test(candidate.value) ||
      dividerPattern.test(candidate.value),
  );
}

/**
 * Per-file predicate for comments the slop detectors leave alone: JSDoc, toolchain
 * directives, SAFETY comments, and the file's leading license header.
 */
export function createSlopCommentSkipper(
  sourceCode: SourceCode,
): (comment: ESTree.Comment) => boolean {
  const headerStarts = new Set(leadingLicenseHeaderComments(sourceCode).map((c) => c.start));
  return (comment) =>
    (comment.type === "Block" && comment.value.startsWith("*")) ||
    directivePattern.test(comment.value) ||
    safetyPattern.test(comment.value) ||
    headerStarts.has(comment.start);
}

const rfcPattern = /\bRFC[\s-]*\d+\b/iu;
const urlPattern = /https?:\/\/[^\s<>()[\]{}"']+/giu;
const trackerUrlPatterns = [
  /^https?:\/\/(?:www\.)?github\.com\/[^\s/?#]+\/[^\s/?#]+\/(?:issues|pull)\/\d+(?:[?#][^\s]*)?$/iu,
  /^https?:\/\/(?:www\.)?gitlab\.com\/(?:[^\s/?#]+\/)+(?:-\/)?(?:issues|merge_requests)\/\d+(?:[?#][^\s]*)?$/iu,
  /^https?:\/\/[^\s/?#]+(?:\/[^\s/?#]+)*\/browse\/[A-Z][A-Z0-9]*-\d+(?:[?#][^\s]*)?$/u,
  /^https?:\/\/linear\.app\/[^\s/?#]+\/issue\/[A-Z][A-Z0-9]*-\d+(?:\/[^\s/?#]+)?(?:[?#][^\s]*)?$/u,
];

/** Exact GitHub/GitLab/Linear/Jira issue URLs, RFC mentions, and ids matching `ticketPattern`. */
export function hasTrackerOrRfcReference(value: string, ticketPattern: RegExp): boolean {
  const urls = value.match(urlPattern) ?? [];
  const prose = value.replace(urlPattern, "");
  return (
    rfcPattern.test(prose) ||
    ticketPattern.test(prose) ||
    urls.some((url) => {
      const normalizedUrl = url.replace(/[.,]$/u, "");
      return trackerUrlPatterns.some((pattern) => pattern.test(normalizedUrl));
    })
  );
}

/** A `//` comment with nothing but indentation before it on its line. */
export function isStandaloneLineComment(sourceCode: SourceCode, comment: ESTree.Comment): boolean {
  if (comment.type !== "Line") return false;
  const line = sourceCode.lines[comment.loc.start.line - 1];
  return line !== undefined && line.slice(0, comment.loc.start.column).trim() === "";
}

export function commentRemovalRange(sourceCode: SourceCode, comment: ESTree.Comment): [number, number] {
  const text = sourceCode.text;
  let start = comment.start;
  while (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) start -= 1;
  const ownsLine = start === 0 || text[start - 1] === "\n";
  let end = comment.end;
  if (ownsLine) {
    if (text[end] === "\r") end += 1;
    if (text[end] === "\n") end += 1;
  }
  return [start, end];
}
