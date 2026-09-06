import type { ExtractWarning } from "@elmeragroup/api-extractor";

export type ApiArtifactDiagnostic = {
  readonly component: string;
  readonly warning: ExtractWarning;
};

export type RscStatus = "client" | "server";
export type ApiPropOrigin = "declared" | "recipe-axis" | { readonly packageName: string };
export type ApiProp = {
  name: string;
  origin: ApiPropOrigin;
  type: string;
  shortType: string | null;
  defaultValue: string | null;
  description: string;
  required: boolean;
};
export type ApiPart = {
  name: string;
  rsc: RscStatus;
  sourcePath: string;
  props: readonly ApiProp[];
  forwardedFrom: readonly string[];
  forwardedCount: number;
};
export type ComponentApiArtifact = {
  $generated: string;
  slug: string;
  parts: readonly ApiPart[];
};
