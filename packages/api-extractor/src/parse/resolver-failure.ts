/**
 * A resolver/policy failure raised inside the compiler-free parser. It keeps
 * the symbol breadcrumb and the original cause without naming a compiler type;
 * the extraction shell classifies it into an `ExtractError`. This module is
 * Effect-free so `src/parse/**` can import it without reaching the Effect
 * runtime.
 */
export class ResolverFailure extends Error {
  readonly symbolStack: readonly string[];
  override readonly cause: unknown;

  constructor(options: {
    readonly message: string;
    readonly symbolStack: readonly string[];
    readonly cause: unknown;
  }) {
    super(options.message);
    this.name = "ResolverFailure";
    this.symbolStack = options.symbolStack;
    this.cause = options.cause;
  }
}
