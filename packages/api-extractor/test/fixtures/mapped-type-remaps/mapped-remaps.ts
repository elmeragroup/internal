export interface Base {
	a: boolean;
	b?: string;
}

// Every key is remapped away, so the mapped type contributes no members.
export type Filtered = { [K in keyof Base as never]: number };

// A conditional remap admits one key and renames it while filtering the rest.
export type Renamed = { [K in keyof Base as K extends "a" ? "renamed" : never]: number };

// Modifier arithmetic on a plain (non-container) mapped object: `+?` makes
// every member optional even when the template value cannot be undefined.
export type PlusOptional = { [P in keyof Base]+?: number };

// `-?` strips the optionality a homomorphic map would otherwise carry over.
export type StripOptional = { [P in keyof Base]-?: number };

// A finite instantiated alias resolves through ordinary object resolution, so
// its members are compiler-synthesized rather than declared.
export type MapAlias<K extends string, V = unknown> = { [P in K]?: V };

export type Specialized = MapAlias<"a" | "b">;

export function authored(params: Base) {}
export function filtered(params: Filtered) {}
export function renamed(params: Renamed) {}
export function plusOptional(params: PlusOptional) {}
export function stripOptional(params: StripOptional) {}
export function specialized(params: Specialized) {}
