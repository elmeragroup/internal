import type * as React from "react";

export function PhoneField(props: {
  autocomplete: "on" | "off" | `section-${string}` | `shipping ${string}`;
}): React.ReactElement {
  return <input autoComplete={props.autocomplete} />;
}
