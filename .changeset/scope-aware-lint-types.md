---
"@elmeragroup/internal": patch
---

The `oxlint/anti-slop` rules `no-unsafe-dictionary-type`, `no-known-value-widening`, `no-object-parameters` and `no-unknown-returns` now resolve type names in their lexical scope. Type parameters, nested aliases, and local or imported `Promise` bindings that shadow a module-level alias no longer produce false positives, and broad aliases declared inside functions are now reported.
