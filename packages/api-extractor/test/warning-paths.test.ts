import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { packageDirectory, stableWarningPath } from "../scripts/fixture-evidence.ts";

describe("stable warning paths", () => {
  it("rewrites a TypeScript lib path to its stable package path", () => {
    expect(stableWarningPath("/repo/node_modules/typescript/lib/lib.es5.d.ts")).toBe(
      "node_modules/typescript/lib/lib.es5.d.ts"
    );
    expect(
      stableWarningPath("/repo/node_modules/.pnpm/typescript@7.0.2/node_modules/typescript/lib/lib.dom.d.ts")
    ).toBe("node_modules/typescript/lib/lib.dom.d.ts");
    expect(stableWarningPath("C:\\repo\\node_modules\\typescript\\lib\\lib.es5.d.ts")).toBe(
      "node_modules/typescript/lib/lib.es5.d.ts"
    );
  });

  it("does not alias another dependency's lib path to the TypeScript lib path", () => {
    const reactTypesPath = resolve(packageDirectory, "node_modules/@types/react/lib/jsx-runtime.d.ts");
    expect(stableWarningPath(reactTypesPath)).toBe("node_modules/@types/react/lib/jsx-runtime.d.ts");
  });

  it("keeps workspace-relative and external paths out of the TypeScript rewrite", () => {
    const sourcePath = resolve(packageDirectory, "src/parse/resolver.ts");
    expect(stableWarningPath(sourcePath)).toBe("src/parse/resolver.ts");

    const external = stableWarningPath("/elsewhere/lib/package/src/button.ts");
    expect(external.startsWith("external/")).toBe(true);
    expect(external).toContain("elsewhere/lib/package/src/button.ts");
  });
});
