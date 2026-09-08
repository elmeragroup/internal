---
"@elmeragroup/internal": patch
---

`elmera/no-tailwind-dark-variant` now reports `dark:` before arbitrary values, important and negative utilities, and in stacked variant chains (for example `dark:[color:red]`, `dark:!bg-red-500`, `dark:-mt-1`, `hover:dark:[color:red]`). Text such as `dark:` inside an arbitrary value is no longer reported.
