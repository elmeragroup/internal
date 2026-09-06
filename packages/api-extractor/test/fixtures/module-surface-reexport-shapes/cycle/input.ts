// A barrel cycle through namespace re-exports. Flattening stops at the first
// revisit with an unresolved-re-export cycle warning instead of recursing.
export * as Loop from "./loop";
