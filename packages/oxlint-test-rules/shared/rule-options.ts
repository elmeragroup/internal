import type { Context } from "@oxlint/plugins";

/**
 * A rule's options object, typed as its `meta.schema` describes it. Every rule that calls this
 * declares `meta.defaultOptions`, which oxlint merges under the configured options, so the object
 * is always present.
 *
 * @template Options - The shape the rule's `meta.schema` and `meta.defaultOptions` give.
 * @param context - The rule context.
 * @returns The options, defaults filled in.
 * @throws Error naming the rule when it runs without the defaults its meta declares.
 */
export function ruleOptions<Options extends object>(context: Context): Options {
  const [options] = context.options;
  if (options === undefined || options === null) {
    throw new Error(`${context.id} has no options; its meta.defaultOptions should supply them.`);
  }
  // SAFETY: oxlint validates every configured options array against the rule's `meta.schema`
  // before `create` runs and merges `meta.defaultOptions` beneath it, so the first entry is an
  // object of exactly that shape.
  return options as Options;
}
