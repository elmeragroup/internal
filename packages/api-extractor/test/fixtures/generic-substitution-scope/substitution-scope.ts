/** The shape every substitution case is anchored on. */
export interface Source {
  id: string;
  tags: string[];
}

/** A generic alias whose body exercises substitution through nested positions. */
export type Wrapper<Value> = {
  direct: Value;
  callback: (input: Value) => Value;
  container: Value[];
  union: Value | null;
  intersection: Value & { tag: "wrapped" };
  returns: () => Value;
};

/** One concrete instantiation the model must substitute through. */
export function useWrapper(value: Wrapper<Source>): void {}

/** Same-named parameters from different declarations must not contaminate. */
export interface Outer<T> {
  inner: Inner<T>;
  rebind: <T>(value: T) => T;
}

/** A second declaration whose parameter shares the outer's name. */
export interface Inner<T> {
  value: T;
}

/** Chained aliases must keep the explicit arguments at every hop. */
export type ChainEnd<Value> = { end: Value };
export type ChainMiddle<Value> = ChainEnd<Value[]>;
export type ChainStart = ChainMiddle<Source>;

/** A recursive generic alias, cut by the per-extraction recursion bound. */
export type RecursiveHolder<Value> = { next?: RecursiveHolder<Value[]>; value: Value };

/** A self-referential instantiation the checker itself rejects. */
export type SelfLoop<T> = { loop: SelfLoop<T> };
