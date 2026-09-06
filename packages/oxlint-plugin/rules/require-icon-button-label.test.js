import { createRuleTester } from "../rule-tester.js";
import requireIconButtonLabel from "./require-icon-button-label.js";

const tester = createRuleTester("tsx");
const error = { messageId: "missingAriaLabel" };

tester.run("elmera/require-icon-button-label", requireIconButtonLabel, {
  valid: [
    {
      name: "labeled Button in an icon size",
      code: `export const ok = <Button size="icon" aria-label="Delete" />;
`,
    },
    {
      name: "Button with visible text is not icon-only",
      code: `export const ok = <Button size="icon-sm">Save</Button>;
`,
    },
    {
      name: "slotted calendar Button may omit a local label",
      code: `export const ok = <Button variant="ghost" size="icon" slot="previous" />;
`,
    },
    {
      name: "labeled InputGroup.Button in an icon size",
      code: `export const ok = <InputGroup.Button size="icon-sm" aria-label="Clear" />;
`,
    },
    {
      name: "labeled RadioIconButton",
      code: `export const ok = <RadioIconButton size="icon" aria-label="List" />;
`,
    },
    {
      name: "ConfirmButton with visible text",
      code: `export const ok = <ConfirmButton size="icon" onConfirm={() => undefined}>Delete</ConfirmButton>;
`,
    },
    {
      name: "Pagination.Link is not a *Button",
      code: `export const ok = <Pagination.Link href="#" size="icon" />;
`,
    },
    {
      name: "non-icon Button needs no aria-label",
      code: `export const ok = <Button size="sm">Save</Button>;
`,
    },
  ],
  invalid: [
    {
      name: "unlabeled Button in an icon size",
      code: `export const bad = <Button size="icon" />;
`,
      errors: [error],
    },
    {
      name: "unlabeled InputGroup.Button in an icon size",
      code: `export const bad = <InputGroup.Button size="icon-sm" />;
`,
      errors: [error],
    },
    {
      name: "unlabeled RadioIconButton",
      code: `export const bad = <RadioIconButton size="icon-xs" />;
`,
      errors: [error],
    },
    {
      name: "unlabeled ConfirmButton in an icon size",
      code: `export const bad = <ConfirmButton size="icon" onConfirm={() => undefined} />;
`,
      errors: [error],
    },
  ],
});
