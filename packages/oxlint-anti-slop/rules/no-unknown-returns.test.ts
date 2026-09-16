import { createRuleTester } from "../shared/rule-tester.ts";
import { noUnknownReturnsRule } from "./no-unknown-returns.ts";

const tester = createRuleTester();
const error = { messageId: "unknownReturn" };

tester.run("anti-slop/no-unknown-returns", noUnknownReturnsRule, {
  valid: [
    "type ImportedValue = unknown;",
    "function parse(): ImportedValue { return input; }",
    "function parse(): User { return user; }",
    "function infer() { return input; }",
    "function generic<Value>(): Value { return value; }",
    "type Value = unknown; function generic<Value>(): Value { return value; }",
    "type Key = unknown; type Mapped<Input> = { [Key in keyof Input]: () => Key };",
    "type Item = unknown; type Unpacked<Input> = Input extends Promise<infer Item> ? () => Item : never;",
    "function cause(): { cause: unknown } { return { cause: input }; }",
    "type Result = { value: unknown }; function load(): Result { return result; }",
    "function load(): Promise<User> { return promise; }",
    "type Promise<T> = { value: T }; declare function f(): Promise<unknown>;",
    'import { Promise } from "./p"; declare function f(): Promise<unknown>;',
    "function outer() { type Promise<T> = { value: T }; function f(): Promise<unknown> { return x; } }",
    'import Promise = require("./p"); declare function f(): Promise<unknown>;',
    {
      name: "a self-referential alias stops the chase",
      code: "type Alias = Alias; function load(): Alias { return input; }",
    },
    {
      name: "a self-referential promise alias stops the chase",
      code: "type Alias = Promise<Alias>; function load(): Alias { return input; }",
    },
    {
      name: "an applied generic alias is not chased",
      code: "type Box<T> = { readonly value: T }; function load(): Box<unknown> { return input; }",
    },
  ],
  invalid: [
    { code: "function load(): unknown { return input; }", errors: [error] },
    { code: "function load(): (unknown) { return input; }", errors: [error] },
    { code: "const load = (): unknown => input;", errors: [error] },
    { code: "type Loader = () => unknown;", errors: [error] },
    { code: "interface Loader { load(): unknown }", errors: [error] },
    { code: "declare function load(): unknown;", errors: [error] },
    { code: "function load(): string | unknown { return input; }", errors: [error] },
    { code: "function load(): Promise<unknown> { return promise; }", errors: [error] },
    { code: "function load(): PromiseLike<unknown> { return promise; }", errors: [error] },
    {
      name: "an alias to parenthesized unknown",
      code: "type Alias = (unknown); function load(): Alias { return input; }",
      errors: [error],
    },
    {
      name: "an alias that chases to a promise of unknown",
      code: "type Hidden = Promise<unknown>; function load(): Hidden { return input; }",
      errors: [error],
    },
    {
      name: "a union member that chases to an alias of unknown",
      code: "type Hidden = unknown; function load(): string | Hidden { return input; }",
      errors: [error],
    },
    { code: "type UnknownValue = unknown; function load(): UnknownValue { return input; }", errors: [error] },
    { code: "type Item = unknown; type Fallback<Input> = Input extends infer Item ? string : () => Item;", errors: [error] },
    {
      code: "type Value = string; function outer() { type Value = unknown; function inner(): Value { return x; } }",
      errors: [error],
    },
    { code: "function Promise() {} function load(): Promise<unknown> { return p; }", errors: [error] },
  ],
});
