import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
const internalRequire = createRequire(import.meta.resolve("@elmeragroup/internal"));
await writeFile(
  "consumer.ts",
  `import { generateApiArtifacts } from "@elmeragroup/internal";
import type { GenerateApiArtifactsOptions } from "@elmeragroup/internal/api-artifacts";
import type { ApiPart } from "@elmeragroup/internal/api-artifacts/model";
import { ProjectExtractor } from "@elmeragroup/internal/api-extractor";
import elmera from "@elmeragroup/internal/oxlint";
import antiSlop from "@elmeragroup/internal/oxlint/anti-slop";
import {
  checkReleasePr,
  parseReleaseCommand,
  releaseCheckedCommit,
  resolveReleasePackage,
  retryRelease,
  verifiedBundleName,
  ReleaseError,
} from "@elmeragroup/internal/release";
import type { PackAndVerify, ReleaseCommand, ReleaseIntent, ReleasePackage } from "@elmeragroup/internal/release";
void ProjectExtractor;
void elmera;
void antiSlop;
void ReleaseError;
void verifiedBundleName;
const releasePackage: ReleasePackage = resolveReleasePackage(".", ".", "canary-consumer");
const adapter: PackAndVerify = { pack: (_intent: ReleaseIntent) => new Uint8Array() };
void checkReleasePr(releasePackage);
void releaseCheckedCommit(releasePackage, adapter, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
void retryRelease(releasePackage, "v0.2.0");
const command: ReleaseCommand = parseReleaseCommand(["main", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
void command;
const options: GenerateApiArtifactsOptions = { projectRoot: ".", tsconfigPath: "tsconfig.json", components: [] };
const result = await generateApiArtifacts(options);
const parts: readonly ApiPart[] = result.components.flatMap(component => component.parts);
void parts;
`
);
const compilerRoot = path.dirname(internalRequire.resolve("typescript/package.json"));
execFileSync(process.execPath, [path.join(compilerRoot, "bin/tsc"), "-p", "tsconfig.json"], {
  stdio: "inherit",
});
await writeFile(
  "model-consumer.ts",
  `import type { ApiArtifactDiagnostic, ApiPart } from "@elmeragroup/internal/api-artifacts/model";
export type BrowserModel = { part: ApiPart; diagnostic: ApiArtifactDiagnostic };
`
);
await writeFile(
  "tsconfig.model.json",
  JSON.stringify({
    compilerOptions: {
      strict: true,
      module: "NodeNext",
      moduleResolution: "NodeNext",
      target: "ES2022",
      lib: ["ES2022", "DOM"],
      types: [],
      skipLibCheck: false,
      noEmit: true,
    },
    files: ["model-consumer.ts"],
  })
);
execFileSync(process.execPath, [path.join(compilerRoot, "bin/tsc"), "-p", "tsconfig.model.json"], {
  stdio: "inherit",
});
console.log("Consumer declarations passed.");
