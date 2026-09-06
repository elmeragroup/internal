import { memo as ambiguousMemo } from "./barrel";
import { memo as transitiveMemo } from "./transitive-barrel";
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
	return <div>{"a" in props ? props.a : props.b}</div>;
}

/** Invalid TS2308 input: the resolver must not treat the first star as React-owned. */
export const AmbiguousWrapped = ambiguousMemo(Render);
export const TransitiveAmbiguousWrapped = transitiveMemo(Render);
