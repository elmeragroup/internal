import { createRuleTester } from "../shared/rule-tester.ts";
import { noObjectParametersRule } from "./no-object-parameters.ts";

const tester = createRuleTester();
const error = { messageId: "objectParameter" };

tester.run("anti-slop/no-object-parameters", noObjectParametersRule, {
	valid: [
		"type Alias = object;",
		"function f(value: Alias) {}",
		"interface Owner { readonly id: string } function f(value: Owner) {}",
		"function f<Value>(value: Value) {}",
		"function f<Value extends object>(value: Value) {}",
		"function f<Value extends Owner, Owner extends { readonly id: string }>(value: Value) {}",
		"type Owner = { readonly id: string }; function f<Value extends Owner>(value: Value) {}",
		"type Alias = object; function consume<Alias>(value: Alias) {}",
		"type Alias = object; type Consumer<Alias> = (value: Alias) => void;",
		"type Alias = object; interface Consumer<Alias> { consume(value: Alias): void }",
		"type Key = object; type Mapped<Input> = { [Key in keyof Input]: (value: Key) => void };",
		"type Item = object; type Unpacked<Input> = Input extends Promise<infer Item> ? (value: Item) => void : never;",
		"type Value = object; function outer() { type Value = { id: string }; function inner(value: Value) {} }",
		"function f(value: Value) {}",
		"function outer() { function inner(value: Value) {} type Value = { id: string }; } type Value = object;",
		{
			name: "a self-referential alias stops the chase",
			code: "type Alias = Alias; function f(value: Alias) {}",
		},
	],
	invalid: [
		{
			name: "a plain object parameter",
			code: "function f(value: object) {}",
			errors: [{ messageId: "objectParameter", data: { parameter: "value" } }],
		},
		{ code: "type Alias = object; function f(value: Alias) {}", errors: [error] },
		{ code: "type Alias = (object); function f(value: Alias) {}", errors: [error] },
		{
			name: "a union member of object makes the alias an object input",
			code: "type Alias = string | object; function f(value: Alias) {}",
			errors: [error],
		},
		{
			name: "a destructuring parameter reports the binding pattern",
			code: "function f({ value }: object) {}",
			errors: [{ messageId: "objectParameter", data: { parameter: "{ value }" } }],
		},
		{
			name: "a parameter property reports the bound name",
			code: "class C { constructor(private readonly value: object) {} }",
			errors: [{ messageId: "objectParameter", data: { parameter: "value" } }],
		},
		{
			name: "a defaulted parameter reports the bound name",
			code: "function f(value: object = {}) {}",
			errors: [{ messageId: "objectParameter", data: { parameter: "value" } }],
		},
		{
			name: "a rest parameter reports the bound name",
			code: "function f(...values: object) {}",
			errors: [{ messageId: "objectParameter", data: { parameter: "values" } }],
		},
		{
			code: "type Item = object; type Fallback<Input> = Input extends infer Item ? string : (value: Item) => void;",
			errors: [error],
		},
		{
			code: "type Value = object; function outer() { type Value = { id: string }; } function other(value: Value) {}",
			errors: [error],
		},
		{
			code: "type Value = { id: string }; function outer() { type Value = object; function inner(value: Value) {} }",
			errors: [error],
		},
		{ code: "function Alias() {} type Alias = object; function f(value: Alias) {}", errors: [error] },
	],
});
