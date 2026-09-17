import type { ExtractWarning } from "@elmeragroup/api-extractor";

/** One extraction warning attributed to the component whose extraction emitted it. */
export type ApiArtifactDiagnostic = {
  /** Slug of the component that produced the warning. */
  readonly component: string;
  /** The warning exactly as the extractor reported it. */
  readonly warning: ExtractWarning;
};

/**
 * Directive-prologue classification of a part's authored implementation module.
 * `client` requires an exact authored `"use client"` or `'use client'` statement at
 * the start of that module; `server` only means that module has no such directive,
 * not that a transitive module graph is server-rendered.
 */
export type RscStatus = "client" | "server";

/**
 * Where a published prop comes from. `declared` is authored by the library,
 * `recipe-axis` is synthesized by a `*-variants` recipe, and the object form names
 * the selected dependency package the prop is accepted from.
 */
export type ApiPropOrigin = "declared" | "recipe-axis" | { readonly packageName: string };

/** One published prop row of a part. */
export type ApiProp = {
  /** Prop name, e.g. `disabled`. */
  name: string;
  /** Declaring owner or dependency package. */
  origin: ApiPropOrigin;
  /** Printed TypeScript type, e.g. `boolean | undefined`. */
  type: string;
  /**
   * One-line type label for a collapsed reference row, e.g. `Union` or `function`.
   * `null` means the printed type is short enough to show in full.
   */
  shortType: string | null;
  /** Authored destructuring default expression, or `null` when the prop has none. */
  defaultValue: string | null;
  /** JSDoc description with repeated paragraphs removed. */
  description: string;
  /** Whether the public props contract requires the prop. */
  required: boolean;
};

/** One published part of a component, e.g. `Dialog.Content`. */
export type ApiPart = {
  /** Display name, e.g. `Dialog.Content`. */
  name: string;
  /** Classification of the authored implementation module that declares or forwards the part. */
  rsc: RscStatus;
  /** Repo-relative path of that module. */
  sourcePath: string;
  /** Published props in UTF-16 code unit order; forwarded props are omitted. */
  props: readonly ApiProp[];
  /**
   * Packages that declare the part's forwarded props, plus the forwarded value's own
   * declaring package when the part forwards a dependency value. Sorted in UTF-16
   * code unit order.
   */
  forwardedFrom: readonly string[];
  /** Number of accepted props omitted from `props` because they are forwarded. */
  forwardedCount: number;
};

/** Serialized form of one component's API artifact. */
export type ComponentApiArtifact = {
  /** Banner naming the generator so consumers know how to regenerate the artifact. */
  $generated: string;
  /** Component slug from the generation options. */
  slug: string;
  /** Published parts in walk order. */
  parts: readonly ApiPart[];
};
