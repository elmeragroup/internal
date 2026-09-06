type Cached<Result> = { readonly value: Result };

type FactCacheSession = {
  readonly ensureOpen: (operation: string) => void;
};

/** Memoizes immutable compiler facts for one extraction session. */
export class SessionFactCache {
  private readonly clearers: (() => void)[] = [];
  private readonly session: FactCacheSession;

  constructor(session: FactCacheSession) {
    this.session = session;
  }

  byHandle<Handle extends object, Result>(
    operation: string,
    read: (handle: Handle) => Result
  ): (handle: Handle) => Result {
    const entries = new Map<Handle, Cached<Result>>();
    this.clearers.push(() => entries.clear());

    return (handle) => {
      this.session.ensureOpen(operation);
      const cached = entries.get(handle);
      if (cached !== undefined) return cached.value;

      const value = freezeFact(read(handle));
      entries.set(handle, { value });
      return value;
    };
  }

  byHandlePair<First extends object, Second, Result>(
    operation: string,
    read: (first: First, second: Second) => Result
  ): (first: First, second: Second) => Result {
    const entries = new Map<First, Map<Second, Cached<Result>>>();
    this.clearers.push(() => entries.clear());

    return (first, second) => {
      this.session.ensureOpen(operation);
      let pairedEntries = entries.get(first);
      if (pairedEntries === undefined) {
        pairedEntries = new Map<Second, Cached<Result>>();
        entries.set(first, pairedEntries);
      }

      const cached = pairedEntries.get(second);
      if (cached !== undefined) return cached.value;

      const value = freezeFact(read(first, second));
      pairedEntries.set(second, { value });
      return value;
    };
  }

  readonly clear = (): void => {
    for (const clear of this.clearers) clear();
    this.clearers.length = 0;
  };
}

/**
 * Freezes normalized records before sharing them between authored read sites.
 * Handles are already frozen by the registry, so recursion stops at them.
 */
function freezeFact<Result>(value: Result): Result {
  return deepFreezeFact(value, new WeakSet());
}

/**
 * A frozen record ends the walk.
 *
 * INVARIANT: every frozen object reachable from a cached fact is frozen all
 * the way down. Only two places in `src/**` freeze anything — this function,
 * which freezes a whole subgraph, and the handle registry, whose handles hold
 * only primitives and the session symbol — so a frozen object never has an
 * unfrozen child, and stopping here cannot leave one behind. Descending again
 * would re-walk the shared sub-records of every later fact, which is the cost
 * this short-circuit removes.
 *
 * A new `Object.freeze` in `src/**` breaks that invariant the moment it
 * freezes a literal with mutable children. `test/session-fact-cache-freeze
 * .test.ts` fails on any freeze site outside those two, so the invariant is
 * re-argued rather than silently lost.
 */
function deepFreezeFact<Result>(value: Result, seen: WeakSet<object>): Result {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- normalized compiler facts are deep-frozen before caching.
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  if (Object.isFrozen(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) deepFreezeFact(descriptor.value, seen);
  }
  return Object.freeze(value);
}
