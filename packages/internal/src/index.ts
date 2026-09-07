import type { GenerateApiArtifactsOptions, GenerateApiArtifactsResult } from "@elmeragroup/api-artifacts";

export type {
  ApiArtifactComponent,
  ApiArtifactDiagnostic,
  ApiPart,
  ApiProp,
  ApiPropOrigin,
  ComponentApiArtifact,
  GeneratedApiComponent,
  GenerateApiArtifactsOptions,
  GenerateApiArtifactsResult,
  RscStatus,
} from "@elmeragroup/api-artifacts";
export { ApiArtifactsError, ApiArtifactsDriftError } from "@elmeragroup/api-artifacts/errors";

/** Generates API artifacts with the Elmera UI documentation defaults. */
export async function generateApiArtifacts(
  options: GenerateApiArtifactsOptions
): Promise<GenerateApiArtifactsResult> {
  const { generateApiArtifacts: generate } = await import("@elmeragroup/api-artifacts");
  return generate({
    ...options,
    includeExternalTypes: options.includeExternalTypes ?? ["@base-ui/react"],
    allowedWarningCodes: options.allowedWarningCodes ?? ["unsupported-type-fallback"],
    generatedBy:
      options.generatedBy ??
      "Generated from TypeScript types and JSDoc by @elmeragroup/internal. Do not edit.",
  });
}
