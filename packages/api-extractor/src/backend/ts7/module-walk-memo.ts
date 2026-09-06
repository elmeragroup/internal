/**
 * Memos for facts one module walk asks more than once.
 *
 * The descriptor walk reaches the same symbol from several directions: a
 * re-export is asked whether it is a specifier both when its chain is decided
 * and again when its descriptor is built, and a chain hop resolves its
 * forwarding statement once as the hop it steps to and once as the hop it
 * steps from. Ordering asks its container for authored positions once per
 * export. Each of those reads a native compiler member, so the repeat is
 * wasted work.
 *
 * Both memos key on compiler objects, which belong to one open session, and
 * hold every key weakly. `memoizeWalkFact` is additionally keyed by the walk,
 * so one walk's answers are unreachable once it returns and are never reused
 * by another walk or another session. `memoizeSubjectFact`'s map is
 * module-global and does outlive a session, but only weakly: an entry stays
 * reachable exactly as long as the compiler object it describes, and it is
 * collected with that object once the session drops it.
 */

/**
 * Memoizes a fact of one subject for the lifetime of one walk.
 *
 * The walk is the first key: a session's answers depend on its own
 * external-type selection and file trees, and one walk object exists for the
 * lifetime of one `readModule` call.
 */
export function memoizeWalkFact<Walk extends object, Subject extends object, Value>(
  read: (walk: Walk, subject: Subject) => Value
): (walk: Walk, subject: Subject) => Value {
  const byWalk = new WeakMap<Walk, WeakMap<Subject, { readonly value: Value }>>();
  return (walk, subject) => {
    let entries = byWalk.get(walk);
    if (entries === undefined) {
      entries = new WeakMap<Subject, { readonly value: Value }>();
      byWalk.set(walk, entries);
    }
    // The wrapper keeps an absent fact — an unforwarded symbol — cached
    // rather than re-read on every later question about it.
    const cached = entries.get(subject);
    if (cached !== undefined) return cached.value;
    const value = read(walk, subject);
    entries.set(subject, { value });
    return value;
  };
}

/**
 * Memoizes a fact that depends only on a compiler object, not on the walk
 * asking for it — an authored source file's own statement positions.
 */
export function memoizeSubjectFact<Subject extends object, Value>(
  read: (subject: Subject) => Value
): (subject: Subject) => Value {
  const entries = new WeakMap<Subject, { readonly value: Value }>();
  return (subject) => {
    const cached = entries.get(subject);
    if (cached !== undefined) return cached.value;
    const value = read(subject);
    entries.set(subject, { value });
    return value;
  };
}
