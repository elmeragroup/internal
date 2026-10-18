import { createRuleTester } from "../shared/rule-tester.ts";
import { noKnownValueWideningRule } from "./no-known-value-widening.ts";

const tester = createRuleTester();

const error = { messageId: "widening" };

function widening(subject: string, target: string) {
	return { messageId: "widening", data: { subject, target } };
}

const prelude = "type Command = () => void; const startCommand = () => {};";

tester.run("anti-slop/no-known-value-widening", noKnownValueWideningRule, {
	valid: [
		`${prelude} const commands: Record<string, Command> = {};`,
		`${prelude} type Index<T> = Record<string, T>; const commands: Index<Command> = {};`,
		`${prelude} class Registry { commands: Record<string, Command> = {}; }`,
		`${prelude} class Registry { accessor commands: Record<string, Command> = {}; }`,
		`${prelude} let commands: Record<string, Command>; commands = {};`,
		`${prelude} function create(): Record<string, Command> { return {}; }`,
		`${prelude} const create = (): Record<string, Command> => ({});`,
		`${prelude} const commands = {} as Record<string, Command>;`,
		`${prelude} const commands = <Record<string, Command>>{};`,
		`${prelude} const commands = { start: startCommand };`,
		`${prelude} const commands = { start: startCommand } as const;`,
		`${prelude} const commands = { start: startCommand } satisfies Record<string, Command>;`,
		`${prelude} type Commands = Record<string, Command>; const commands = { start: startCommand } as const satisfies Commands;`,
		`${prelude} interface Commands { readonly start: Command } const commands: Commands = { start: startCommand };`,
		`${prelude} type Commands = { readonly start: Command }; const commands: Commands = { start: startCommand };`,
		`${prelude} type PermissionLevels = { readonly [Level in Permission]: number }; const levels: PermissionLevels = { admin: 1 };`,
		`${prelude} function create() { return { start: startCommand }; }`,
		`${prelude} interface Commands { readonly start: Command } function create(): Commands { return { start: startCommand }; }`,
		`${prelude} declare function make(): Record<string, Command>; const commands: Record<string, Command> = make();`,
		`${prelude} import { Commands } from './types'; const commands: Commands = { start: startCommand };`,
		"type Value = unknown; function outer() { type Value = { id: string }; const v: Value = { id: \"a\" }; }",
		'type ViaRecord = Partial<Record<"a" | "b", string>>; const first: ViaRecord = { a: "text" };',
		'type ViaMapped = { [K in "a" | "b"]?: string }; const second: ViaMapped = { a: "text" };',
		'type ViaRecord = Record<"a" | "b", string>; const table: ViaRecord = { a: "x", b: "y" };',
		'type Key = "a" | "b"; type Table = Partial<Record<Key, string>>; const table: Table = { a: "text" };',
		'type Key = "a" | "b"; type Table = { readonly [K in Key]?: string }; const table: Table = { a: "text" };',
		'type Table = Record<`a-${"x" | "y"}`, string>; const table: Table = { "a-x": "text" };',
		'type Table = Record<1 | 2, string>; const table: Table = { 1: "one" };',
		'type PerKey<T> = { [K in "a" | "b"]?: T }; const table: PerKey<string> = { a: "text" };',
		'type PerKey<T> = Partial<Record<"a" | "b", T>>; const table: PerKey<string> = { a: "text" };',
		'type ByKey<K extends PropertyKey, T> = Record<K, T>; const table: ByKey<"a" | "b", string> = { a: "x", b: "y" };',
		'import type { Key } from "./keys"; type Table = Record<Key, string>; const table: Table = { a: "text" };',
		'const table: Partial<Record<"a" | "b", string>> = {};',
		'const table: { [K in "a" | "b"]?: string } = {};',
		'type ByKey<K extends string> = Record<K, string>; type Prefixed<K extends string> = ByKey<`x-${K}`>; const table: Prefixed<"a"> = { "x-a": "text" };',
		'type A<T, U> = Record<U, T>; type B<T, U> = A<U, T>; const table: B<"a", string> = { a: "x" };',
		'type T = "a"; type Inner = Record<T, string>; type Outer<T> = Inner; const table: Outer<string> = { a: "x" };',
		'type Mutable<T> = { -readonly [K in keyof T]: T[K] }; const table: Mutable<{ readonly a: string }> = { a: "x" };',
		'type Wrap<T> = Pick<T, "a">; const table: Wrap<Record<string, string>> = { a: "x" };',
		'type Table = { [K in "a" | "b" as `on${K}`]?: string }; const table: Table = { ona: "x" };',
		'type A = Record<B, string>; type B = A; const table: A = { a: "x" };',
		'type Table = Omit<Record<string, string>, string>; const table: Table = { a: "text" };',
		'type Table = { [K in `${string}${never}`]: string }; const table: Table = { a: "text" };',
		'type Never = never; type Table = Record<`${string}${Never}`, string>; const table: Table = { a: "text" };',
		'type Table = Record<never, string>; const table: Table = {};',
		'type Keys<T> = Record<keyof T, string>; const table: Keys<{ a: string }> = { a: "x" };',
		'type Table = { [K in keyof {} as `${K}${string}`]: string }; const table: Table = { a: "x" };',
		'type Empty = {}; type Table = Record<`${keyof Empty}${string}`, string>; const table: Table = { a: "x" };',
		'interface Point { x: number } type Copy<T> = { [K in keyof T]: T[K] }; const table: Copy<Point> = { x: 1 };',
	],
	invalid: [
		{ code: "const value: unknown = {};", errors: [error] },
		{ code: "const value: object = {};", errors: [error] },
		{ code: "let value: unknown; value = {};", errors: [error] },
		{ code: "function create(): unknown { return {}; }", errors: [error] },
		{
			code: `${prelude} const commands: Record<string, Command> = { start: startCommand };`,
			errors: [error],
		},
		{
			code: `${prelude} const commands: { [key: string]: Command } = { start: startCommand };`,
			errors: [error],
		},
		{
			code: `${prelude} const commands: { [K in string]: Command } = { start: startCommand };`,
			errors: [error],
		},
		{
			code: `${prelude} const commands: { start: Command } = { start: startCommand };`,
			errors: [error],
		},
		{
			code: `${prelude} const commands = { start: startCommand } as Record<string, Command>;`,
			errors: [error],
		},
		{
			code: `${prelude} const commands = ({ start: startCommand } as Record<string, Command>) as object;`,
			errors: 1,
		},
		{
			code: `${prelude} class Registry { commands: Record<string, Command> = { start: startCommand }; }`,
			errors: [error],
		},
		{
			code: `${prelude} let commands: Record<string, Command>; commands = { start: startCommand };`,
			errors: [error],
		},
		{
			code: `${prelude} function create(): Record<string, Command> { return { start: startCommand }; }`,
			errors: [error],
		},
		{
			code: `${prelude} function create(): { start: Command } { return { start: startCommand }; }`,
			errors: [error],
		},
		{
			code: `${prelude} const source = { start: startCommand }; const commands: Record<string, Command> = source;`,
			errors: [error],
		},
		{
			code: `${prelude} type Open = Record<string, Command>; const source = { start: startCommand }; const commands: Open = source;`,
			errors: [error],
		},
		{
			code: `${prelude} type Open = { [key: string]: Command }; const source = { start: startCommand }; const commands: Open = source;`,
			errors: [error],
		},
		{
			code: `${prelude} type Open = { [key in string]: Command }; const source = { start: startCommand }; const commands: Open = source;`,
			errors: [error],
		},
		{
			code: `${prelude} type Open = Readonly<Record<string, Command>>; const source = { start: startCommand }; const commands: Open = source;`,
			errors: [error],
		},
		{
			code: `${prelude} type Index<T> = Record<string, T>; const commands: Index<Command> = { start: startCommand };`,
			errors: [error],
		},
		{
			code: `${prelude} type Index<T> = Record<string, T>; type CommandsByName = Index<Command>; const commands: CommandsByName = { start: startCommand };`,
			errors: [error],
		},
		{
			code: `${prelude} type Index<T = Command> = Record<string, T>; const commands: Index = { start: startCommand };`,
			errors: [error],
		},
		{ code: "const value: unknown = 1;", errors: [error] },
		{ code: "const value: object = [];", errors: [error] },
		{
			code: "type Value = { id: string }; function outer() { type Value = unknown; const v: Value = { id: \"a\" }; }",
			errors: [error],
		},
		{
			code: 'const first: Partial<Record<"a" | "b", string>> = { a: "text" };',
			errors: [widening("binding `first`", "inline mapped")],
		},
		{
			code: 'const first: Record<"a" | "b", string> = { a: "x", b: "y" };',
			errors: [widening("binding `first`", "inline mapped")],
		},
		{
			code: 'const second: { [K in "a" | "b"]?: string } = { a: "text" };',
			errors: [widening("binding `second`", "inline mapped")],
		},
		{
			code: 'type Key = "a" | "b"; const table: Partial<Record<Key, string>> = { a: "text" };',
			errors: [widening("binding `table`", "inline mapped")],
		},
		{
			code: 'import type { Key } from "./keys"; const table: Record<Key, string> = { a: "text" };',
			errors: [widening("binding `table`", "inline mapped")],
		},
		{
			code: 'const table = { a: "text" } as Partial<Record<"a" | "b", string>>;',
			errors: [widening("assertion", "inline mapped")],
		},
		{
			code: "const table: Record<string, string> = { a: \"text\" };",
			errors: [widening("binding `table`", "open dictionary")],
		},
		{
			code: 'const table: Record<"a" | string, string> = { a: "text" };',
			errors: [widening("binding `table`", "open dictionary")],
		},
		{
			code: "const table: Record<`data-${string}`, string> = { \"data-a\": \"text\" };",
			errors: [widening("binding `table`", "open dictionary")],
		},
		{
			code: "const table: { [K in PropertyKey]?: string } = { a: \"text\" };",
			errors: [widening("binding `table`", "open dictionary")],
		},
		{
			code: 'type Table = Record<"a" | string, string>; const table: Table = { a: "text" };',
			errors: [widening("binding `table`", "open dictionary")],
		},
		{
			code: 'type Table = { [K in "a" | string]?: string }; const table: Table = { a: "text" };',
			errors: [widening("binding `table`", "open dictionary")],
		},
		{
			code: "type Key = string; type Table = Partial<Record<Key, string>>; const table: Table = { a: \"text\" };",
			errors: [widening("binding `table`", "open dictionary")],
		},
		{
			code: "type ByKey<K extends PropertyKey, T> = Record<K, T>; const table: ByKey<string, string> = { a: \"text\" };",
			errors: [widening("binding `table`", "generic container")],
		},
		{
			code: "type PerKey<T> = { [K in string]?: T }; const table: PerKey<string> = { a: \"text\" };",
			errors: [widening("binding `table`", "generic container")],
		},
		{
			code: 'type ByKey<K extends string> = Record<K, string>; type Prefixed<K extends string> = ByKey<`x-${K}`>; const table: Prefixed<string> = { "x-a": "text" };',
			errors: [widening("binding `table`", "generic container")],
		},
		{
			code: 'type Key = string; type ByKey<Key extends PropertyKey> = Record<Key, string>; const table: ByKey<Key> = { a: "text" };',
			errors: [widening("binding `table`", "generic container")],
		},
		{
			code: 'type A<T, U> = Record<U, T>; type B<T, U> = A<U, T>; const table: B<string, string> = { a: "x" };',
			errors: [widening("binding `table`", "generic container")],
		},
		{
			code: 'type ByKey<K extends PropertyKey, R = Record<K, string>> = R; const table: ByKey<string> = { a: "x" };',
			errors: [widening("binding `table`", "generic container")],
		},
		{
			code: 'type Id<T> = T; type Table = Record<Id<Id<string>>, string>; const table: Table = { a: "text" };',
			errors: [widening("binding `table`", "open dictionary")],
		},
		{
			code: 'type Table<T> = Omit<Record<string, T>, never>; const table: Table<string> = { a: "text" };',
			errors: [widening("binding `table`", "generic container")],
		},
		{
			code: 'type Table<T> = Pick<Record<string, T>, string>; const table: Table<string> = { a: "text" };',
			errors: [widening("binding `table`", "generic container")],
		},
		{
			code: 'const table: Omit<Record<string, string>, "b"> = { a: "text" };',
			errors: [widening("binding `table`", "open dictionary")],
		},
		{
			code: 'type Table<T> = { [K in "a" | "b" as string]?: T }; const table: Table<string> = { other: "text" };',
			errors: [widening("binding `table`", "generic container")],
		},
		{
			code: 'const table: { [K in "a" | "b" as string]?: string } = { other: "text" };',
			errors: [widening("binding `table`", "open dictionary")],
		},
		{
			code: 'const table: { [K in "a" | "b" as `on${K}`]?: string } = { ona: "text" };',
			errors: [widening("binding `table`", "inline mapped")],
		},
		{
			code: 'type Table = { [K in string as `on${K}`]?: string }; const table: Table = { ona: "text" };',
			errors: [widening("binding `table`", "open dictionary")],
		},
		{
			code: 'type Table = Record<any, string>; const table: Table = { a: "text" };',
			errors: [widening("binding `table`", "open dictionary")],
		},
		{
			code: 'const table: Record<any, string> = { a: "text" };',
			errors: [widening("binding `table`", "open dictionary")],
		},
		{
			code: 'type Table = Record<keyof any, string>; const table: Table = { a: "text" };',
			errors: [widening("binding `table`", "open dictionary")],
		},
		{
			code: 'type Table = Record<string | never, string>; const table: Table = { a: "text" };',
			errors: [widening("binding `table`", "open dictionary")],
		},
		{
			code: 'type Table = Omit<Record<string, string>, "a" | never>; const table: Table = { b: "text" };',
			errors: [widening("binding `table`", "open dictionary")],
		},
		{
			code: 'type Mutable<T> = { -readonly [K in keyof T]: T[K] }; const table: Mutable<Record<string, string>> = { a: "x" };',
			errors: [widening("binding `table`", "generic container")],
		},
		{
			code: 'type Keys<T> = Record<keyof T, string>; const table: Keys<Record<string, string>> = { a: "x" };',
			errors: [widening("binding `table`", "generic container")],
		},
		{
			code: 'type Same<T> = Pick<T, keyof T>; const table: Same<Record<string, string>> = { a: "x" };',
			errors: [widening("binding `table`", "generic container")],
		},
		{
			code: 'type Copy<T> = { [K in keyof T]: T[K] }; const table: Copy<any> = { a: "x" };',
			errors: [widening("binding `table`", "generic container")],
		},
		{
			code: 'const table: Record<keyof { [key: string]: string }, string> = { a: "x" };',
			errors: [widening("binding `table`", "open dictionary")],
		},
		{
			code: 'type Dynamic = any; type Copy<T> = { [K in keyof T]: T[K] }; const table: Copy<Dynamic> = { a: "x" };',
			errors: [widening("binding `table`", "generic container")],
		},
		{
			code: 'type Table = Record<keyof never, string>; const table: Table = { a: "x" };',
			errors: [widening("binding `table`", "open dictionary")],
		},
		{
			code: 'type Open = Record<string, string>; type Table = Record<keyof Open, string>; const table: Table = { a: "x" };',
			errors: [widening("binding `table`", "open dictionary")],
		},
		{
			code: 'interface Dict { [key: string]: string } type Copy<T> = { [K in keyof T]: T[K] }; const table: Copy<Dict> = { a: "x" };',
			errors: [widening("binding `table`", "generic container")],
		},
		{
			code: 'interface Dict { [key: string]: string } type Table = Record<keyof Dict, string>; const table: Table = { a: "x" };',
			errors: [widening("binding `table`", "open dictionary")],
		},
		{
			code: 'const table: Record<number, string> = { 1: "text" };',
			errors: [widening("binding `table`", "open dictionary")],
		},
	],
});
