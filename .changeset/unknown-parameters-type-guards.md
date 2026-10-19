---
"@elmeragroup/internal": patch
---

The `oxlint/anti-slop` rule `no-unknown-parameters` accepts a default-off `allowInTypeGuards` option, matching `no-runtime-typeof`. When it is on, an `unknown` parameter is not reported if the function returns a type predicate or assertion that names it, such as `function isText(value: unknown): value is string` or `function assertText(value: unknown): asserts value is string`. Other `unknown` parameters of the same function are still reported, as is an overload implementation whose own return type is not a predicate, and the `cause` exemption is unchanged.
