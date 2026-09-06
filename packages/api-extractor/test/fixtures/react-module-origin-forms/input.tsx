import { React as FakeReact } from "./fake-react";
import { React as LocalReact } from "./local-react";
import { bridgedMemo } from "./bridge-two";
import { memo as starMemo } from "./bridge-star-two";
import { React as bridgedReact } from "./bridge-namespace-two";
import * as Bridge from "./bridge-nested";
import * as AliasBridge from "./alias-namespace";
import * as React from "react";

interface CallbackProps {
	callbackOnly: number;
}

/** A local module can mimic React's namespace and wrapper names. */
export const FakeModule = FakeReact.memo((props: CallbackProps): FakeReact.ReactElement => {
	return {} as FakeReact.ReactElement;
});

/** A project namespace can mimic React's namespace and wrapper names. */
export const ShadowedNamespace = LocalReact.memo((props: CallbackProps): LocalReact.ReactElement => {
	return {} as LocalReact.ReactElement;
});

interface BridgedProps {
	bridgedOnly: string;
}

/** A multi-hop re-export whose ultimate public module remains React. */
export const Bridged = bridgedMemo(function Bridged(props: BridgedProps): React.ReactElement {
	return <div>{props.bridgedOnly}</div>;
});

interface StarBridgedProps {
	starOnly: string;
}

/** A star re-export chain keeps the original React module origin as well. */
export const StarBridged = starMemo(function StarBridged(props: StarBridgedProps): React.ReactElement {
	return <div>{props.starOnly}</div>;
});

interface NamespaceBridgedProps {
	namespaceOnly: string;
}

/** A namespace import re-export still points at the public React module. */
export const NamespaceBridged = bridgedReact.memo(function NamespaceBridged(
	props: NamespaceBridgedProps,
): React.ReactElement {
	return <div>{props.namespaceOnly}</div>;
});

const BridgeProbe = Bridge.React.memo;

interface NestedFirstProps {
	a: string;
}

interface NestedSecondProps {
	b: number;
}

function NestedRender(props: NestedFirstProps): React.ReactElement;
function NestedRender(props: NestedSecondProps): React.ReactElement;
function NestedRender(props: NestedFirstProps | NestedSecondProps): React.ReactElement {
	return <div>{"a" in props ? props.a : props.b}</div>;
}

/** A namespace export keeps the complete Bridge.React.memo member path. */
export const NestedBridgeWrapped = Bridge.React.memo(NestedRender);

const R = React;

interface LocalFirstProps {
	a: string;
}

interface LocalSecondProps {
	b: number;
}

function LocalRender(props: LocalFirstProps): React.ReactElement;
function LocalRender(props: LocalSecondProps): React.ReactElement;
function LocalRender(props: LocalFirstProps | LocalSecondProps): React.ReactElement {
	return <div>{"a" in props ? props.a : props.b}</div>;
}

/** A local value alias follows its initializer before applying React policy. */
export const LocalAliasWrapped = R.memo(LocalRender);

/** A statically named element access keeps the React wrapper identity. */
export const ElementAccessWrapped = React["memo"](LocalRender);

/** A computed key remains conservative even when its current value is memo. */
const dynamicMemoKey: keyof Pick<typeof React, "memo"> = "memo";
export const DynamicElementAccessWrapped = React[dynamicMemoKey](LocalRender);

interface ExportedFirstProps {
	a: string;
}

interface ExportedSecondProps {
	b: number;
}

function ExportedRender(props: ExportedFirstProps): React.ReactElement;
function ExportedRender(props: ExportedSecondProps): React.ReactElement;
function ExportedRender(props: ExportedFirstProps | ExportedSecondProps): React.ReactElement {
	return <div>{"a" in props ? props.a : props.b}</div>;
}

/** A local alias re-exported as React keeps its origin through a namespace import. */
export const ExportedAliasWrapped = AliasBridge.React.memo(ExportedRender);
