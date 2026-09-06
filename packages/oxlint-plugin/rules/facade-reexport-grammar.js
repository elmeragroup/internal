import { defineRule } from "@oxlint/plugins";

import { normalizeFilename } from "../filename-normalizer.js";

/**
 * Facades are `src/<name>.ts(x)` and `src/react-aria/<name>.ts(x)`.
 * The generated root barrel may use `export *` and is excluded.
 * @param {string} filename
 */
function isEntryFacadeFile(filename) {
  const posix = normalizeFilename(filename);
  if (posix.endsWith("/src/index.ts") || posix.endsWith("/src/index.tsx")) {
    return false;
  }
  if (/\/src\/[a-z0-9-]+\.tsx?$/.test(posix)) {
    return true;
  }
  return /\/src\/react-aria\/[a-z0-9-]+\.tsx?$/.test(posix);
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require src/<name>.ts and src/react-aria/<name>.ts facades to be explicit named re-exports only",
    },
    messages: {
      grammar:
        "Entry facades must be explicit named re-exports only: no export *, no local declarations, no directives.",
    },
    schema: [],
  },
  defaultOptions: [],
  createOnce(context) {
    return {
      Program(program) {
        if (!isEntryFacadeFile(context.filename)) {
          return;
        }
        for (const statement of program.body) {
          if (statement.type === "ExportNamedDeclaration") {
            if (statement.declaration != null || statement.source == null) {
              context.report({ node: statement, messageId: "grammar" });
            }
            continue;
          }
          context.report({ node: statement, messageId: "grammar" });
        }
      },
    };
  },
});
