import * as React from "react";
import { memo as memoAlias } from "react";

/** A nested wrapper keeps the render function's authored props provenance. */
export const NestedWrapped = React.memo(
	React.forwardRef<HTMLDivElement, NestedWrappedProps>(function NestedWrapped(props, ref) {
		return (
			<div ref={ref} data-label={props.label}>
				{props.children}
			</div>
		);
	}),
	(previous, next) => previous.label === next.label,
);

export interface NestedWrappedProps {
	label: string;
	children?: React.ReactNode;
}

/** A namespace exposes the compound subcomponent as a static API member. */
export function CompoundRoot(props: CompoundRoot.Props): React.ReactElement {
	return <section>{props.title}</section>;
}

export namespace CompoundRoot {
	export interface Props {
		title: string;
	}

	/** The child remains independently extractable under CompoundRoot. */
	export function Item(props: Item.Props): React.ReactElement {
		return <span>{props.value}</span>;
	}

	export namespace Item {
		export interface Props {
			value: number;
		}
	}
}

const DefaultWrapped = React.forwardRef<HTMLDivElement, DefaultWrapped.Props>(
	function DefaultWrapped(props, ref) {
		return <div ref={ref}>{props.label}</div>;
	},
);

namespace DefaultWrapped {
	export interface Props {
		label: string;
	}
}

/** A default wrapped export keeps its authored display name and props. */
export default DefaultWrapped;

interface WrappedGenericProps<Value> {
	value: Value;
}

/** A generic render function remains callable after memo wrapping. */
export const GenericWrapped = React.memo(function GenericWrapped<Value>(
	props: WrappedGenericProps<Value>,
): React.ReactElement {
	return <div>{String(props.value)}</div>;
});

interface OverloadedWrappedPropsA {
	text: string;
}

interface OverloadedWrappedPropsB {
	count: number;
}

function OverloadedRender(props: OverloadedWrappedPropsA): React.ReactElement;
function OverloadedRender(props: OverloadedWrappedPropsB): React.ReactElement;
function OverloadedRender(
	props: OverloadedWrappedPropsA | OverloadedWrappedPropsB,
): React.ReactElement {
	return <div>{"text" in props ? props.text : props.count}</div>;
}

/** An overloaded render function keeps every callable props form after memo wrapping. */
export const OverloadedWrapped = React.memo(OverloadedRender);

interface ArbitraryResolvedProps {
	resolvedOnly: string;
}

interface ArbitraryCallbackProps {
	callbackOnly: number;
}

declare function customWrap<T>(value: T): React.ForwardRefExoticComponent<ArbitraryResolvedProps>;

/** An arbitrary callback wrapper must not contribute callback props. */
export const ArbitraryWrapped = customWrap(function ArbitraryWrapped(
	props: ArbitraryCallbackProps,
): React.ReactElement {
	return <div>{props.callbackOnly}</div>;
});

interface AliasWrappedProps {
	value: string;
}

/** A named React import remains a supported wrapper identity. */
export const AliasWrapped = memoAlias(function AliasWrapped(props: AliasWrappedProps): React.ReactElement {
	return <div>{props.value}</div>;
});

interface ComparedWrappedProps {
	value: string;
}

interface ComparatorOnlyProps {
	comparatorOnly: boolean;
}

const comparator = ((previous: ComparatorOnlyProps, next: ComparatorOnlyProps) =>
	previous.comparatorOnly === next.comparatorOnly) as unknown as (
	previous: Readonly<ComparedWrappedProps>,
	next: Readonly<ComparedWrappedProps>,
) => boolean;

/** The optional memo comparator is not a render function. */
export const ComparedWrapped = React.memo(
	function ComparedWrapped(props: ComparedWrappedProps): React.ReactElement {
		return <div>{props.value}</div>;
	},
	comparator,
);

interface ImplementationLeakTextProps {
	text: string;
}

interface ImplementationLeakCountProps {
	count: number;
}

interface ImplementationLeakOnlyProps<Value> {
	implementationOnly: Value;
}

function ImplementationLeakRender(props: ImplementationLeakTextProps): React.ReactElement;
function ImplementationLeakRender(props: ImplementationLeakCountProps): React.ReactElement;
function ImplementationLeakRender<ImplementationOnlyValue>(
	props:
		| ImplementationLeakTextProps
		| ImplementationLeakCountProps
		| ImplementationLeakOnlyProps<ImplementationOnlyValue>,
): React.ReactElement {
	return <div>{"text" in props ? props.text : "count" in props ? props.count : String(props.implementationOnly)}</div>;
}

/** The overload implementation's extra prop is not public. */
export const ImplementationLeakWrapped = React.memo(ImplementationLeakRender);

interface GenericImplementationLeakProps<Value> {
	value: Value;
}

interface GenericImplementationLeakCountProps {
	count: number;
}

function GenericImplementationLeakRender<Value>(
	props: GenericImplementationLeakProps<Value>,
): React.ReactElement;
function GenericImplementationLeakRender(
	props: GenericImplementationLeakCountProps,
): React.ReactElement;
function GenericImplementationLeakRender<ImplementationOnlyValue>(
	props:
		| GenericImplementationLeakProps<ImplementationOnlyValue>
		| GenericImplementationLeakCountProps
		| ImplementationLeakOnlyProps<ImplementationOnlyValue>,
): React.ReactElement {
	return <div>{"value" in props ? String(props.value) : "count" in props ? props.count : String(props.implementationOnly)}</div>;
}

/** Public overload generics survive while implementation-only generics do not. */
export const GenericImplementationLeakWrapped = React.memo(GenericImplementationLeakRender);
