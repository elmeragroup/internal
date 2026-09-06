import { generateApiArtifacts as generate } from "@elmeragroup/api-artifacts";
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
export { ApiArtifactsError, ApiArtifactsDriftError } from "@elmeragroup/api-artifacts";

/** Generates API artifacts with the Elmera UI documentation defaults. */
export function generateApiArtifacts(
  options: GenerateApiArtifactsOptions
): Promise<GenerateApiArtifactsResult> {
  return generate({
    ...options,
    includeExternalTypes: options.includeExternalTypes ?? ["@base-ui/react"],
    allowedWarningCodes: options.allowedWarningCodes ?? ["unsupported-type-fallback"],
    generatedBy:
      options.generatedBy ??
      "Generated from TypeScript types and JSDoc by @elmeragroup/internal. Do not edit.",
  });
}
