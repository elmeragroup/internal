import { createRuleTester } from "../shared/rule-tester.ts";
import { noForbiddenTermInSymbolNamesRule } from "./no-shape-in-symbol-names.ts";

const error = { messageId: "forbiddenSymbolName" };

const tester = createRuleTester();

tester.run("anti-slop/no-shape-in-symbol-names", noForbiddenTermInSymbolNamesRule, {
  valid: [
    "const payload = 1;",
    "function submit() {}",
    "interface OrderLine { readonly id: string }",
    "const ellipses = 1;",
    "const splitAt = value => value;",
  ],
  invalid: [
    { code: "const shape = 1;", errors: [error] },
    { code: "function userShape() {}", errors: [error] },
    { code: "type UserShape = { readonly userShape: string };", errors: [error, error] },
    { code: "interface Item { readonly shape: string }", errors: [error] },
    { code: "const payload = { shape: 1 };", errors: [error] },
    { code: "class ShapeRegistry {}", errors: [error] },
    { code: "class Registry { #shape = 1; }", errors: [error] },
    { code: "const registry = { shape() {} };", errors: [error] },
    { code: "shaped: for (;;) { break shaped; }", errors: [error, error] },
    { code: "type Options = { onChange(shape: string): void };", errors: [error] },
  ],
});

const jsxTester = createRuleTester("tsx");

jsxTester.run("anti-slop/no-shape-in-symbol-names-jsx", noForbiddenTermInSymbolNamesRule, {
  valid: ["const node = <main><span /></main>;", "const node = <div className='shape-free' />;"],
  invalid: [
    { code: "const node = <Shape />;", errors: [error] },
    { code: "const node = <div shape='x' />;", errors: [error] },
    { code: "const node = <Shape.Item />;", errors: [error] },
  ],
});
