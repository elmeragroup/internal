import type { ComponentProps } from "@fixture/render";
import type * as React from "react";

export type LabelProps = ComponentProps<"div"> & {
  text: string;
};

export function Label(props: LabelProps): React.ReactElement {
  return <div>{props.text}</div>;
}
