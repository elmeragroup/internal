import * as React from "react";

interface FirstProps {
	a: string;
}

interface SecondProps {
	b: number;
}

function Render(props: FirstProps): React.ReactElement;
function Render(props: SecondProps): React.ReactElement;
function Render(props: FirstProps | SecondProps): React.ReactElement {
	return "a" in props
		? React.createElement("div", null, props.a)
		: React.createElement("div", null, props.b);
}

/** A legacy angle-bracket assertion remains transparent to module-origin lookup. */
export const AngleAssertionWrapped = (<typeof React>React).memo(Render);
