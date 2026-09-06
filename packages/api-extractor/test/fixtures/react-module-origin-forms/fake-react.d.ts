export interface ResolvedProps {
	resolvedOnly: string;
}

export namespace React {
	export interface ReactElement {}

	export interface ForwardRefExoticComponent<Props> {
		(props: Props): ReactElement;
	}

	export function memo<Value>(value: Value): ForwardRefExoticComponent<ResolvedProps>;
}
