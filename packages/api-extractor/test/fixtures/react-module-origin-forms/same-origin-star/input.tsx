import * as React from "react";
import { memo } from "./barrel";

interface FirstProps {
	a: string;
}

interface SecondProps {
	b: number;
}

function Render(props: FirstProps): React.ReactElement;
function Render(props: SecondProps): React.ReactElement;
function Render(props: FirstProps | SecondProps): React.ReactElement {
	return <div>{"a" in props ? props.a : props.b}</div>;
}

/** Both stars resolve this wrapper to React's one memo declaration. */
export const SameOriginWrapped = memo(Render);
