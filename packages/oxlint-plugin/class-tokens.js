/**
 * Split a whitespace-separated Tailwind class string into class tokens. Class
 * lists are whitespace-delimited, so runs of whitespace collapse to one
 * boundary.
 *
 * @param {string} str - A candidate class string.
 * @returns {string[]} The non-empty class tokens in source order.
 */
export function classTokens(str) {
  return str.split(/\s+/).filter(Boolean);
}
