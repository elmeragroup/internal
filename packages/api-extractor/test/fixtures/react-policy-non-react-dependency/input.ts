import {
	FC,
	forwardRef,
	FunctionComponent,
	memo,
	React as NonReactReact,
	type LookalikeRef,
	type LookalikeRefCallback,
} from "non-react-lookalikes";

export type { FC as LookalikeFC } from "non-react-lookalikes";
export type { FunctionComponent as LookalikeFunctionComponent } from "non-react-lookalikes";
export type { ForwardRefExoticComponent as LookalikeForwardRefExoticComponent } from "non-react-lookalikes";
export type { MemoExoticComponent as LookalikeMemoExoticComponent } from "non-react-lookalikes";
export type { NamedExoticComponent as LookalikeNamedExoticComponent } from "non-react-lookalikes";

export const LookalikeMemo = memo((props: { readonly callbackOnly: boolean }) => props.callbackOnly);
export const LookalikeForwardRef = forwardRef(
	(props: { readonly callbackOnly: boolean }) => props.callbackOnly
);

export const LookalikeNamespacedMemo = NonReactReact.memo(
	(props: { readonly callbackOnly: boolean }) => props.callbackOnly
);
export const LookalikeNamespacedForwardRef = NonReactReact.forwardRef(
	(props: { readonly callbackOnly: boolean }) => props.callbackOnly
);

export interface LookalikeRefProps {
	readonly refCallback: LookalikeRefCallback<string>;
	readonly optionalRef?: LookalikeRef<string>;
}
