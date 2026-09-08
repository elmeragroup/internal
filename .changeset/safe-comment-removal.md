---
"@elmeragroup/internal": patch
---

The `anti-slop/no-slop-comments` lint rule no longer offers its "Delete this comment" suggestion for a block comment that has code on both sides of it on the same line, such as `return/* TODO */x` or a multi-line comment between `return` and its value. Accepting that suggestion could join tokens or change automatic semicolon insertion. The diagnostic itself is unchanged, and suggestions for `//` comments and for block comments that start or end their line still delete the comment as before.
