declare const brand: unique symbol;

export type Branded = {
	readonly [brand]: number;
	named: string;
};

export type BrandedKeys = keyof Branded;

export declare const bareSymbol: unique symbol;
