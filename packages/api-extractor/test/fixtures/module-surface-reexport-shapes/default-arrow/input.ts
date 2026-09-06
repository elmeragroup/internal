// The default export is a bare arrow function expression: no symbol anchors
// the expression, so the export is skipped with upstream's
// missing-default-export-symbol condition.
export default () => ({ ok: true });
