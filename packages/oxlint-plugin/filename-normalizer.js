/**
 * @param {string} filename
 */
export function normalizeFilename(filename) {
  return filename.replaceAll("\\", "/");
}
