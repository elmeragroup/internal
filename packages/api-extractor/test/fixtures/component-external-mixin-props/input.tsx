import type { ComponentProps } from "@fixture/render";
import type { Variants } from "@fixture/variants";
import type * as React from "react";

const widgetVariants = {
  size: { sm: "text-sm", lg: "text-lg" },
} as const;

export type WidgetProps = ComponentProps<"div"> &
  Variants<typeof widgetVariants> & {
    /** Visual weight of the widget. */
    level?: number;
  };

/** A component whose props are its own members plus two dependency-owned mixins. */
export function Widget(props: WidgetProps): React.ReactElement {
  return <div>{props.level}</div>;
}

/** A component object whose only member is the widget above. */
export const Toolkit = { Widget };

export type LabelledWidgetProps =
  | (WidgetProps & {
      /** Renders the text label. */
      icon?: false;
    })
  | (WidgetProps & {
      /** Renders only an icon, which needs an accessible name. */
      icon: true;
      "aria-label": string;
    });

/** A variant union whose second arm re-declares a prop React's attributes also declare. */
export function LabelledWidget(props: LabelledWidgetProps): React.ReactElement {
  return <div aria-label={props["aria-label"]}>{props.level}</div>;
}
