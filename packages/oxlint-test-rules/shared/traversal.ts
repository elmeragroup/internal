import type { Context, ESTree, Variable } from "@oxlint/plugins";

/**
 * The one bounded traversal every recursive analysis of the test-file rules runs on: the value
 * evaluator in `resolve.ts` and each rule's own transfer functions (a measurement, a class read,
 * a path's spelling, a clock's coverage) alike. `resolve.ts`'s contract states what the evaluator
 * follows; this module states how any analysis walks.
 *
 * - A walk is one top-level analysis call and everything it reaches: a nested analysis call joins
 *   the walk that is running, so all of them share its active path and its budget.
 * - A step already on the active path is a cycle cut: the step returns its analysis's cycle value,
 *   and the steps it is inside now depend on that activation.
 * - Each analysis keeps a step's result per file (`run`), with the cycle cuts it depends on, its
 *   cost and its depth. Cost is the size of the step's unfolded computation: one for the step plus
 *   the cost of every step it reads, kept or not, so a value read twice costs twice. Depth is the
 *   most steps it is inside at once. An entry with no cuts holds for every later read; one with
 *   cuts holds while each activation it cut is still on the active path. A hit charges the entry's
 *   cost and depth to the walk, so a walk spends the same budget whether its results come from the
 *   memo or not, and a value shared down a long chain (each link reading the last twice) passes the
 *   budget, warm or cold, while still being computed once.
 * - A walk has a budget (`WORK_BUDGET`). Past it, every further step returns its analysis's
 *   `unresolved` value, the top-level call returns its own, and the walk drops every entry it kept,
 *   so a verdict depends neither on what was analysed before nor on the order.
 * - `isolated` runs a once-per-file build (an index of the file's calls or mutations) in walks of
 *   its own, so building it charges no rule's budget.
 * - Every recursive function in `rules/` and `shared/` that follows a value or an expression runs
 *   as a step of an analysis, keyed by everything its result depends on. Other recursion follows
 *   syntax (`unwrap`, a logical test's operands), bounded by the tree, or a value's member chain
 *   (`targetOf`), bounded by the depth a walk is charged to build it. `traversal.guard.test.ts`
 *   runs every rule on self-referencing and doubled values of every shape to hold this.
 */

/** The steps one walk may take, and how many it may be inside at once. */
const WORK_BUDGET = { steps: 10_000, depth: 500 } as const;

/**
 * A step an analysis can be inside: a node, a binding, a composite key from `pairKey`, or an
 * analysis's own evidence object (`EvidenceKey`). A key covers everything the step's result
 * depends on besides the file.
 */
export type StepKey = ESTree.Node | Variable | PairKey | EvidenceKey;

/** A stable object standing for two keys together, so one analysis step can depend on both. */
export type PairKey = { readonly _tag: "pair" };

/**
 * An object an analysis's result depends on, such as the classes one test run supplies: made once
 * per value and reused, so the same evidence is the same key.
 */
export type EvidenceKey = { readonly _tag: "evidence" };

/** One step's record while it runs: its activation, the cuts beneath it, its cost and its depth. */
type Frame = { readonly activation: number; readonly cuts: Set<number>; cost: number; depth: number };

/** A kept result: its value, the activations it cut, and its cold cost and depth. */
type Entry<T> = {
  readonly value: T;
  readonly cuts: ReadonlySet<number>;
  readonly cost: number;
  readonly depth: number;
};

/** One walk's state. */
type Walk = {
  /** Each analysis's active steps, by key, with their activation numbers. */
  readonly active: Map<object, Map<StepKey, number>>;
  /** Every activation on the active path. */
  readonly live: Set<number>;
  readonly frames: Frame[];
  /** Undo actions for the entries this walk kept, run if it exhausts its budget. */
  readonly kept: Array<() => void>;
  steps: number;
  exhausted: boolean;
};

/** The walk running now, if any. */
let current: Walk | undefined;

/** The last activation number handed out. */
let activations = 0;

/** Interned pair keys: one object per ordered pair. */
const PAIRS = new WeakMap<StepKey, WeakMap<StepKey, PairKey>>();

/**
 * The one key standing for two keys together, the same object every time.
 *
 * @param first - The first key.
 * @param second - The second key.
 * @returns The interned pair.
 */
export function pairKey(first: StepKey, second: StepKey): PairKey {
  const byFirst = PAIRS.get(first) ?? new WeakMap<StepKey, PairKey>();
  PAIRS.set(first, byFirst);
  const known = byFirst.get(second);
  if (known !== undefined) return known;
  const made: PairKey = { _tag: "pair" };
  byFirst.set(second, made);
  return made;
}

/**
 * Run a once-per-file build outside any running walk: each analysis call it makes starts a walk of
 * its own, so the build charges nothing to the walk that first needed it.
 *
 * @template T - What the build makes.
 * @param build - The build.
 * @returns What it made.
 */
export function isolated<T>(build: () => T): T {
  const outer = current;
  current = undefined;
  try {
    return build();
  } finally {
    current = outer;
  }
}

/**
 * Whether a walk has run past its budget. Read through a call because any step's transfer function
 * may exhaust the walk it runs in.
 */
function isExhausted(walk: Walk): boolean {
  return walk.exhausted;
}

/** Charge a kept result's cold cost and depth to the running walk. */
function charge(walk: Walk, entry: Entry<unknown>): void {
  walk.steps += entry.cost;
  if (walk.steps > WORK_BUDGET.steps || walk.frames.length + entry.depth > WORK_BUDGET.depth)
    walk.exhausted = true;
  absorb(walk.frames.at(-1), entry);
}

/** Fold a finished or reused step's cuts, cost and depth into the frame it ran under. */
function absorb(
  parent: Frame | undefined,
  child: { readonly cuts: ReadonlySet<number>; readonly cost: number; readonly depth: number }
): void {
  if (parent === undefined) return;
  for (const cut of child.cuts) parent.cuts.add(cut);
  parent.cost += child.cost;
  parent.depth = Math.max(parent.depth, child.depth + 1);
}

/** Whether every cut a kept result depends on is still live in the walk. */
function allLive(cuts: ReadonlySet<number>, live: ReadonlySet<number>): boolean {
  for (const cut of cuts) if (!live.has(cut)) return false;
  return true;
}

/**
 * A recursive analysis over a file: a transfer function from a step's key to a value, memoized,
 * cycle-cut and budgeted by the traversal this module describes.
 *
 * @template T - The analysis's value.
 */
export class Analysis<T> {
  /** Each file's kept results, by program. */
  private readonly memos = new WeakMap<ESTree.Node, WeakMap<StepKey, Entry<T>>>();

  /** The value of a step past the budget: one no rule reports on. */
  private readonly unresolved: T;

  /**
   * @param unresolved - The value of a step past the budget: one no rule reports on.
   */
  constructor(unresolved: T) {
    this.unresolved = unresolved;
  }

  /**
   * Run one step and keep its result for the file.
   *
   * @param context - The rule context, whose program owns the memo.
   * @param key - The step.
   * @param compute - The transfer function, which may run further steps.
   * @param onCycle - The value of a step reached again while it runs.
   * @returns The step's value.
   */
  run(context: Context, key: StepKey, compute: () => T, onCycle: () => T): T {
    const program = context.sourceCode.ast;
    const memo = this.memos.get(program) ?? new WeakMap<StepKey, Entry<T>>();
    this.memos.set(program, memo);
    return this.walk(key, compute, onCycle, memo);
  }

  /**
   * Run one step without keeping its result: a binding or a function the walk passes through,
   * which takes part in cycle cuts and the budget only.
   *
   * @param key - The step.
   * @param compute - The transfer function.
   * @param onCycle - The value of a step reached again while it runs.
   * @returns The step's value.
   */
  pass(key: StepKey, compute: () => T, onCycle: () => T): T {
    return this.walk(key, compute, onCycle, undefined);
  }

  /**
   * Whether a step of this analysis is on the active path; when it is, the running step now
   * depends on that activation, as a cycle cut does.
   *
   * @param key - The step.
   * @returns Whether it is running.
   */
  cutsBackTo(key: StepKey): boolean {
    const activation = current?.active.get(this)?.get(key);
    if (current === undefined || activation === undefined) return false;
    current.frames.at(-1)?.cuts.add(activation);
    return true;
  }

  /** One step in the running walk, or a new walk when none runs. */
  private walk(
    key: StepKey,
    compute: () => T,
    onCycle: () => T,
    memo: WeakMap<StepKey, Entry<T>> | undefined
  ): T {
    if (current !== undefined) return this.step(current, key, compute, onCycle, memo);
    const walk: Walk = {
      active: new Map(),
      live: new Set(),
      frames: [],
      kept: [],
      steps: 0,
      exhausted: false,
    };
    current = walk;
    try {
      const value = this.step(walk, key, compute, onCycle, memo);
      if (!isExhausted(walk)) return value;
      for (const undo of walk.kept) undo();
      return this.unresolved;
    } finally {
      current = undefined;
    }
  }

  /** One step inside a walk. */
  private step(
    walk: Walk,
    key: StepKey,
    compute: () => T,
    onCycle: () => T,
    memo: WeakMap<StepKey, Entry<T>> | undefined
  ): T {
    const active = walk.active.get(this) ?? new Map<StepKey, number>();
    walk.active.set(this, active);
    const running = active.get(key);
    if (running !== undefined) {
      walk.frames.at(-1)?.cuts.add(running);
      return onCycle();
    }
    if (walk.exhausted) return this.unresolved;
    const known = memo?.get(key);
    if (known !== undefined && allLive(known.cuts, walk.live)) {
      charge(walk, known);
      return isExhausted(walk) ? this.unresolved : known.value;
    }
    walk.steps += 1;
    if (walk.steps > WORK_BUDGET.steps || walk.frames.length >= WORK_BUDGET.depth) {
      walk.exhausted = true;
      return this.unresolved;
    }
    activations += 1;
    const frame: Frame = { activation: activations, cuts: new Set(), cost: 1, depth: 1 };
    active.set(key, frame.activation);
    walk.live.add(frame.activation);
    walk.frames.push(frame);
    try {
      const value = compute();
      frame.cuts.delete(frame.activation);
      if (memo !== undefined && !isExhausted(walk)) {
        memo.set(key, { value, cuts: frame.cuts, cost: frame.cost, depth: frame.depth });
        walk.kept.push(() => memo.delete(key));
      }
      return isExhausted(walk) ? this.unresolved : value;
    } finally {
      walk.frames.pop();
      active.delete(key);
      walk.live.delete(frame.activation);
      absorb(walk.frames.at(-1), frame);
    }
  }
}
