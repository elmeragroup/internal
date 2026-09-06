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
      name: "labeled Button with expression icon size",
      code: `export const ok = <Button size={"icon"} aria-label="Delete" />;
`,
    },
    {
      name: "labeled InputGroup.Button with expression icon-sm size",
      code: `export const ok = <InputGroup.Button size={"icon-sm"} aria-label="Clear" />;
`,
    },
    {
      name: "labeled Button with icon variant",
      code: `export const ok = <Button variant="icon" aria-label="Delete" />;
`,
    },
    {
      name: "labeled Button with expression icon variant",
      code: `export const ok = <Button variant={"icon"} aria-label="Delete" />;
`,
    },
    {
      name: "labeled Button with static template icon size",
      code: 'export const ok = <Button size={`icon`} aria-label="Delete" />;\n',
    },
    {
      name: "labeled Button with static template icon variant",
      code: 'export const ok = <Button variant={`icon`} aria-label="Delete" />;\n',
    },
    {
      name: "labeled Button with identifier icon size",
      code: `export const ok = <Button size={icon} aria-label="Delete" />;
`,
    },
    {
      name: "interpolated size template is not a known icon size",
      code: "export const ok = <Button size={`icon${suffix}`} />;\n",
    },
    {
      name: "dynamic aria-label identifier is treated as labeled",
      code: `export const ok = <Button size="icon" aria-label={label} />;
`,
    },
    {
      name: "translation-call aria-label is treated as labeled",
      code: `export const ok = <Button size={"icon"} aria-label={t("delete")} />;
`,
    },
    {
      name: "nonempty static template aria-label is labeled",
      code: "export const ok = <Button variant={`icon`} aria-label={`Delete`} />;\n",
    },
    {
      name: "nonempty expression string child is visible text",
      code: `export const ok = <Button size="icon">{"Save"}</Button>;
`,
    },
    {
      name: "translation-call child is visible text",
      code: `export const ok = <Button size="icon">{t("Save")}</Button>;
`,
    },
    {
      name: "interpolated template child is visible text",
      code: 'export const ok = <Button size="icon">{`Save ${name}`}</Button>;\n',
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
    {
      name: "unlabeled Button with expression icon size",
      code: `export const bad = <Button size={"icon"} />;
`,
      errors: [error],
    },
    {
      name: "unlabeled InputGroup.Button with expression icon-sm size",
      code: `export const bad = <InputGroup.Button size={"icon-sm"} />;
`,
      errors: [error],
    },
    {
      name: "unlabeled Button with icon variant",
      code: `export const bad = <Button variant="icon" />;
`,
      errors: [error],
    },
    {
      name: "unlabeled Button with expression icon variant",
      code: `export const bad = <Button variant={"icon"} />;
`,
      errors: [error],
    },
    {
      name: "unlabeled Button with static template icon size",
      code: "export const bad = <Button size={`icon`} />;\n",
      errors: [error],
    },
    {
      name: "unlabeled InputGroup.Button with static template icon-sm size",
      code: "export const bad = <InputGroup.Button size={`icon-sm`} />;\n",
      errors: [error],
    },
    {
      name: "unlabeled Button with static template icon variant",
      code: "export const bad = <Button variant={`icon`} />;\n",
      errors: [error],
    },
    {
      name: "unlabeled RadioIconButton with expression icon size",
      code: `export const bad = <RadioIconButton size={"icon"} />;
`,
      errors: [error],
    },
    {
      name: "unlabeled Button with identifier icon size",
      code: `export const bad = <Button size={icon} />;
`,
      errors: [error],
    },
    {
      name: "empty direct aria-label is not a usable name",
      code: `export const bad = <Button size="icon" aria-label="" />;
`,
      errors: [error],
    },
    {
      name: "whitespace direct aria-label is not a usable name",
      code: `export const bad = <Button size="icon" aria-label=" " />;
`,
      errors: [error],
    },
    {
      name: "empty expression aria-label is not a usable name",
      code: `export const bad = <Button size={"icon"} aria-label={""} />;
`,
      errors: [error],
    },
    {
      name: "whitespace expression aria-label is not a usable name",
      code: `export const bad = <InputGroup.Button size="icon-sm" aria-label={" "} />;
`,
      errors: [error],
    },
    {
      name: "empty static template aria-label is not a usable name",
      code: "export const bad = <Button size={`icon`} aria-label={``} />;\n",
      errors: [error],
    },
    {
      name: "whitespace static template aria-label is not a usable name",
      code: 'export const bad = <Button variant="icon" aria-label={` `} />;\n',
      errors: [error],
    },
    {
      name: "bare aria-label is not a usable name",
      code: `export const bad = <Button size="icon" aria-label />;
`,
      errors: [error],
    },
    {
      name: "null aria-label is not a usable name",
      code: `export const bad = <Button size="icon" aria-label={null} />;
`,
      errors: [error],
    },
    {
      name: "false aria-label is not a usable name",
      code: `export const bad = <RadioIconButton size="icon" aria-label={false} />;
`,
      errors: [error],
    },
    {
      name: "empty expression string child is not visible text",
      code: `export const bad = <Button size="icon">{""}</Button>;
`,
      errors: [error],
    },
    {
      name: "whitespace expression string child is not visible text",
      code: `export const bad = <Button size="icon">{" "}</Button>;
`,
      errors: [error],
    },
    {
      name: "empty static template child is not visible text",
      code: 'export const bad = <Button size="icon">{``}</Button>;\n',
      errors: [error],
    },
  ],
});
