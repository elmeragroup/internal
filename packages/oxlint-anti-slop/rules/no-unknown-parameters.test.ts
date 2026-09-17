import { createRuleTester } from "../shared/rule-tester.ts";
import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = createRuleTester();
const error = { messageId: "unknownParameter" };
const named = (parameter: string) => ({
  messageId: "unknownParameter",
  data: { parameter },
});

tester.run("anti-slop/no-unknown-parameters", noUnknownParametersRule, {
  valid: [
    "function f(value: string) {}",
    "function f() {}",
    "function f(value = initial) {}",
    "function f(value: Value) {}",
    "function f(cause: unknown) {}",
    "function f(cause?: unknown) {}",
    "function f(...values: unknown[]) {}",
    "function f(value: Promise<unknown>) {}",
    "const f = (value: string) => value;",
    "function f<Value>(value: Value) {}",
    "class C { method(cause: unknown) {} }",
    "class C { constructor(readonly cause: unknown) {} }",
    "type Handler = (cause: unknown) => void;",
    "type Expected = unknown;",
  ],
  invalid: [
    { code: "function f(value: unknown) {}", errors: [named("value")] },
    { code: "function f(value: unknown = initial) {}", errors: [named("value")] },
    { code: "function f(...values: unknown) {}", errors: [named("values")] },
    { code: "function f({ value }: unknown) {}", errors: [named("{ value }")] },
    { code: "function f({ value }: unknown = {}) {}", errors: [named("{ value }")] },
    { code: "const f = (value: unknown) => value;", errors: [error] },
    { code: "type Handler = (value: unknown) => void;", errors: [error] },
    { code: "interface Handler { call(value: unknown): void }", errors: [error] },
    { code: "interface Handler { (value: unknown): void }", errors: [error] },
    { code: "type Ctor = new (value: unknown) => object;", errors: [error] },
    { code: "abstract class C { abstract method(value: unknown): void; }", errors: [error] },
    { code: "type Options = { onChange(value: unknown): void };", errors: [error] },
    { code: "declare function f(value: unknown): void;", errors: [error] },
    { code: "function f(cause: unknown, value: unknown) {}", errors: [error] },
    { code: "function f(value: unknown, other: unknown) {}", errors: [error, error] },
    {
      code: "class C { constructor(private readonly value: unknown) {} }",
      errors: [named("value")],
    },
    { code: "class C { method(value: unknown) {} }", errors: [error] },
    { code: "function f(value: unknown) {} function g(other: unknown) {}", errors: [error, error] },
  ],
});
