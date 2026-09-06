/** A base shape whose public members are inherited by every subclass. */
export class BaseShape {
	/** The base name. */
	name: string = "";
	/** Describes the shape. */
	describe(): string {
		return this.name;
	}
	private auditTrail: string[] = [];
	protected sharedSeed(): number {
		return 7;
	}
	static fromName(value: string): BaseShape {
		const shape = new BaseShape();
		shape.name = value;
		return shape;
	}
}

/**
 * A derived shape.
 *
 * @typeParam T - The unit type carried by the shape.
 */
export class DerivedShape<T> extends BaseShape {
	/** The collected units. */
	readonly units: T[] = [];
	/** Adds one unit and reports the new size. */
	add(unit: T): number {
		return this.units.push(unit);
	}
	/** Reads the current size. */
	get size(): number {
		return this.units.length;
	}
	static create<T>(unit: T): DerivedShape<T> {
		const derived = new DerivedShape<T>();
		derived.units.push(unit);
		return derived;
	}
}

/** A counter that is callable and also carries named state. */
export interface Counter {
	(start: number): number;
	step: number;
	reset(): void;
}

export const makeCounter: Counter = Object.assign((): number => 0, {
	step: 1,
	reset(): void {},
});

/** A point constructed through `new`, which no interface model can carry. */
export interface ConstructablePoint {
	new (x: number): { x: number };
	label?: string;
}

/** Overloads that differ materially must all survive. */
export declare function parseValue(input: string): number;
export declare function parseValue(input: number, precision: number): string;

/** Optional and rest parameters survive with their optionality. */
export declare function emit(event: string, detail?: number, ...rest: boolean[]): void;

/** A callable-first shape that also declares a construct signature. */
export interface CallableAndConstructable {
	(start: number): number;
	new (label: string): { label: string };
}

class InternalRegistry {
	open: boolean = true;
	private secrets: string[] = [];
}

/** Reaches the non-exported registry through object resolution of the alias. */
export type RegistryAlias = InternalRegistry;

/** The instance side of this class is merged with an interface of signatures. */
export class MergedCounter {
	value: number = 0;
}

export interface MergedCounter {
	tick(): number;
}
