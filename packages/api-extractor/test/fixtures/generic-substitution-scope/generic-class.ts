/** A generic class whose declaration carries constrained parameters. */
export class Repository<T extends object = Record<string, string>> {
  /** A typed cache. */
  cache?: Map<string, T>;

  /** A generic method with its own parameter shadowing nothing. */
  find<K extends keyof T>(key: K): T[K] | undefined {
    return undefined;
  }

  /** A method whose parameter shadows the class parameter on purpose. */
  reset<T>(fallback: T): T {
    return fallback;
  }
}

/** A call signature carrying its own constrained parameter. */
export interface Validator {
  <V extends string>(input: V, against: V[]): V;
}
