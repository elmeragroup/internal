import { createRuleTester } from "../shared/rule-tester.ts";
import { noUnknownTypeAliasesRule } from "./no-unknown-type-aliases.ts";

const tester = createRuleTester();
const error = { messageId: "unknownAlias" };

tester.run("anti-slop/no-unknown-type-aliases", noUnknownTypeAliasesRule, {
	valid: [
		"type User = { readonly id: string };",
		"type Alias = string; type UserId = Alias;",
		"type Known = string; function f() { type Hidden = Known; }",
		"import Value from './value'; function f() { type Hidden = Value; }",
		"type Value = string; function f() { type Hidden = (Value); }",
		"type UnknownValue = string; function f<UnknownValue>() { type Hidden = UnknownValue; }",
		{
			name: "a union member of unknown does not make the alias itself unknown",
			code: "type Alias = string | unknown;",
		},
		{
			name: "a self-referential alias stops the chase",
			code: "type Alias = Alias;",
		},
		{
			name: "an applied generic alias is not chased",
			code: "type Box<T> = { readonly value: T }; type Alias = Box<unknown>;",
		},
	],
	invalid: [
		{ code: "type Alias = unknown;", errors: [error] },
		{ code: "type Current = unknown;", errors: [error] },
		{ code: "type UnknownValue = unknown; type Alias = UnknownValue;", errors: [error, error] },
		{
			name: "a parenthesized unknown resolves",
			code: "type Alias = (unknown);",
			errors: [error],
		},
		{ code: "function f() { type Payload = unknown; }", errors: [error] },
		{ code: "namespace N { type Payload = unknown; }", errors: [error] },
		{ code: "class C { static { type Payload = unknown; } }", errors: [error] },
		{
			code: "switch (input) { case 1: type Payload = unknown; break; default: type Other = unknown; }",
			errors: [error, error],
		},
		{
			code: "function f() { type UnknownValue = unknown; type Alias = UnknownValue; }",
			errors: [error, error],
		},
		{
			code: "type Value = unknown; function f() { type Value = string; type Alias = Value; }",
			errors: [error],
		},
		{
			code: "type Value = string; function f() { type Value = unknown; type Alias = Value; }",
			errors: [error, error],
		},
	],
});
