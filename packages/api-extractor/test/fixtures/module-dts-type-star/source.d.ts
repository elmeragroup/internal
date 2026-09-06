export interface Value {
	value: string;
}

export interface OtherValue {
	other: number;
}

export const RuntimeValue: {
	readonly kind: "runtime";
};
