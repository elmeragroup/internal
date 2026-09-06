/**
 * Options accepted by the public operation.
 *
 * @deprecated Use NewOptions instead.
 * @since 1.0
 */
export interface Options {
  /** A stable display label. */
  readonly label?: string;
  /** A nested object value. */
  nested: {
    /** The nested identifier. */
    id: number;
  };
  /** A method on the object shape. */
  format(value: string): string;
}

/** The operation mode. */
export enum Mode {
  /** Fast operation. */
  Fast = "fast",
  /** Slow operation. */
  Slow = 2,
}

/** Uses the supplied options. */
export function use(options: Options = { nested: { id: 1 }, format: String }): Mode {
  return Mode.Fast;
}

export interface ReturnShape {
  value: string;
}

export function makeReturnShape(): ReturnShape {
  return { value: "ready" };
}

export interface ReturnMethods {
  make(): ReturnShape;
}

export interface ConfigureOptions {
  enabled?: boolean;
}

export function configure({ enabled = false }: ConfigureOptions): ConfigureOptions {
  return { enabled };
}
