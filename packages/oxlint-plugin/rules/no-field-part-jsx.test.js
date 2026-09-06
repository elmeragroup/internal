import { createRuleTester } from "../rule-tester.js";
import noFieldPartJsx from "./no-field-part-jsx.js";

const tester = createRuleTester("tsx");
const error = (part) => ({ messageId: "fieldPart", data: { part } });
const textField = "packages/ui/src/components/text-field/text-field.tsx";
const checkbox = "packages/ui/src/components/checkbox/checkbox.tsx";
const frame = "packages/ui/src/components/field/field-frame.tsx";

tester.run("elmera/no-field-part-jsx", noFieldPartJsx, {
  valid: [
    {
      name: "FieldFrame may render the parts it owns",
      filename: frame,
      code: `export function FieldFrame() {
  return (
    <Field.Root>
      <Field.Label />
      <Field.Description />
      <Field.Error />
    </Field.Root>
  );
}
`,
    },
    {
      name: "a labeled composite may render through FieldFrame",
      filename: textField,
      code: `export function TextField() {
  return <FieldFrame label={label}>{children}</FieldFrame>;
}
`,
    },
    {
      name: "unrelated modules may still render Field parts",
      filename: "packages/ui/src/components/input-group/input-group.tsx",
      code: `export function Example() {
  return <Field.Root><Field.Label /></Field.Root>;
}
`,
    },
  ],
  invalid: [
    {
      name: "TextField may not reopen Field.Label",
      filename: textField,
      code: `export function TextField() {
  return <Field.Label>{label}</Field.Label>;
}
`,
      errors: [error("Label")],
    },
    {
      name: "CheckboxGroup may not reopen Field.Set or Field.Legend",
      filename: checkbox,
      code: `export function CheckboxGroup() {
  return (
    <Field.Set>
      <Field.Legend>{label}</Field.Legend>
    </Field.Set>
  );
}
`,
      errors: [error("Set"), error("Legend")],
    },
  ],
});
