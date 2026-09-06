import React = require("react");
import Bridge = require("./bridge");
import * as NamedBridge from "./named-bridge";

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

/** Uses the CommonJS import-equals form accepted by @types/react's export = React. */
export const ImportEqualsWrapped = React.memo(Render);
export const ExportEqualsBridgeWrapped = Bridge.memo(Render);
export const NamedImportEqualsWrapped = NamedBridge.React.memo(Render);
