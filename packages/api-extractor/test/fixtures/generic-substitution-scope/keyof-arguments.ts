export interface Obj {
	a: string;
	b: number;
}

export type Box<V> = { value: V };

export function direct(x: Box<keyof Obj>) {}
export type Keys = keyof Obj;
export function aliased(x: Box<Keys>) {}
export interface Holder {
	keys: Box<keyof Obj>;
}
