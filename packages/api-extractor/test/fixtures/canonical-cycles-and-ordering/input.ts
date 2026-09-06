/** A union whose members reference the union itself. */
export type Cycle = CycleLeft | CycleRight;

type CycleLeft = { value: number; nested: Cycle };
type CycleRight = { value: string; nested: Cycle };

/** An intersection whose member references the intersection itself. */
export type CyclicIntersection = IntersectionBase & { self: CyclicIntersection };

type IntersectionBase = { id: number };

interface Callable {
  (param: number): number;
}

interface ExtraData {
  data?: string;
}

/** A callable intersection is described by its call signatures. */
export declare const callable: Callable & ExtraData;

export interface Flags {
  /** An authored boolean stays one intrinsic member. */
  toggled?: boolean;
  /** Conflicting members of an intersection are preserved. */
  merged: MergedShape;
}

type MergedShape = LabelledShape & { label: string; count: number };

type LabelledShape = {
  label: string;
  count?: number;
  /** Documented once on the first declaring member. */
  readonly tags: readonly string[];
};

type Alpha = { alpha: number };
type Beta = { beta: string };

/** The checker deduplicates `Alpha & Alpha` before members are matched. */
export type DuplicateIntersection = Alpha & Alpha & Beta;

type Left = { left: string };
type Right = { right: number };
type Pair<First, Second> = { first: First } & { second: Second };

/** A generic intersection reference exposes type arguments, not member syntax. */
export declare const pair: Pair<Left, Right>;

type OptionalParameter<Value> = Value | string;

/** An instantiated alias union keeps the authored member order. */
export declare function instantiatedAlias(value: OptionalParameter<number>): void;

type GenericContainer<Value> = Value[] | string;

/** An instantiated generic container keeps its authored position. */
export declare function genericContainer(value: GenericContainer<number>): void;

type SmallUnion = "x" | "y";

/** An authored member that the referenced alias also contains stays visible. */
export type OverlappingUnion = SmallUnion | "x";

type AliasedNull = null;

/** An aliased `null` still sorts to the end of its union. */
export type WithAliasedNull = AliasedNull | string;
