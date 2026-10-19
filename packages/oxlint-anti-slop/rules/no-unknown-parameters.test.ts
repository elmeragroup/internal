import { createRuleTester } from "../shared/rule-tester.ts";
import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = createRuleTester();
const error = { messageId: "unknownParameter" };
const named = (parameter: string) => ({
  messageId: "unknownParameter",
  data: { parameter },
});
const allowInTypeGuards = [{ allowInTypeGuards: true }];

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
    {
      code: 'function isText(value: unknown): value is string { return typeof value === "string"; }',
      options: allowInTypeGuards,
    },
    {
      code: 'function assertText(value: unknown): asserts value is string { if (typeof value !== "string") throw new TypeError("Expected text"); }',
      options: allowInTypeGuards,
    },
    {
      code: "function assertPresent(value: unknown): asserts value { if (!value) throw new TypeError(); }",
      options: allowInTypeGuards,
    },
    {
      code: 'const isText = function (value: unknown): value is string { return typeof value === "string"; };',
      options: allowInTypeGuards,
    },
    {
      code: 'const isText = (value: unknown): value is string => typeof value === "string";',
      options: allowInTypeGuards,
    },
    {
      code: 'const assertText: (value: unknown) => asserts value is string = (value: unknown): asserts value is string => { if (typeof value !== "string") throw new TypeError(); };',
      options: allowInTypeGuards,
    },
    {
      code: 'class Guards { isText(value: unknown): value is string { return typeof value === "string"; } }',
      options: allowInTypeGuards,
    },
    {
      code: "declare function isText(value: unknown): value is string;",
      options: allowInTypeGuards,
    },
    {
      code: "type IsText = (value: unknown) => value is string;",
      options: allowInTypeGuards,
    },
    {
      code: "interface Guards { isText(value: unknown): value is string }",
      options: allowInTypeGuards,
    },
    {
      code: "function isText(cause: unknown, value: unknown): value is string { return cause === value; }",
      options: allowInTypeGuards,
    },
    {
      code: "abstract class Guards { abstract isText(value: unknown): value is string; }",
      options: allowInTypeGuards,
    },
    {
      code: "function isText(value?: unknown): value is string { return value !== undefined; }",
      options: allowInTypeGuards,
    },
    {
      code: "class Box {} function isBox(this: unknown): this is Box { return this instanceof Box; }",
      options: allowInTypeGuards,
    },
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
    {
      code: 'function isText(value: unknown): value is string { return typeof value === "string"; }',
      errors: [named("value")],
    },
    {
      code: 'function assertText(value: unknown): asserts value is string { if (typeof value !== "string") throw new TypeError(); }',
      errors: [named("value")],
    },
    {
      code: 'const isText = (value: unknown): value is string => typeof value === "string";',
      options: [{ allowInTypeGuards: false }],
      errors: [named("value")],
    },
    {
      code: 'function describe(value: unknown): string { return typeof value === "string" ? value : "other"; }',
      options: allowInTypeGuards,
      errors: [named("value")],
    },
    {
      code: 'const describe = function (value: unknown): string { return String(value); };',
      options: allowInTypeGuards,
      errors: [named("value")],
    },
    {
      code: "const describe = (value: unknown): boolean => value !== null;",
      options: allowInTypeGuards,
      errors: [named("value")],
    },
    {
      code: "function check(value: unknown) { return value !== null; }",
      options: allowInTypeGuards,
      errors: [named("value")],
    },
    {
      code: 'function isText(value: unknown, fallback: unknown): value is string { return typeof value === "string" || fallback === value; }',
      options: allowInTypeGuards,
      errors: [named("fallback")],
    },
    {
      code: 'const isText = function (value: unknown): value is string { return typeof value === "string"; };',
      errors: [named("value")],
    },
    {
      code: 'function isText(value: unknown): value is string { return typeof value === "string"; }',
      options: [{}],
      errors: [named("value")],
    },
    {
      code: 'function isText(value: unknown): value is string; function isText(value: unknown): boolean { return typeof value === "string"; }',
      options: allowInTypeGuards,
      errors: [named("value")],
    },
    {
      code: "class Box {} function isBox(this: unknown, value: unknown): this is Box { return value === this; }",
      options: allowInTypeGuards,
      errors: [named("value")],
    },
    {
      code: "class Box { matches(value: unknown): this is Box { return value === this; } }",
      options: allowInTypeGuards,
      errors: [named("value")],
    },
    {
      code: 'function isText(value: unknown): value is string { const inner = (other: unknown) => other === value; return typeof value === "string" && inner(value); }',
      options: allowInTypeGuards,
      errors: [named("other")],
    },
  ],
});
