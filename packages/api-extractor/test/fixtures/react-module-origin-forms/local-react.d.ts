export interface ShadowResolvedProps {
	resolvedOnly: string;
}

export namespace React {
	export interface ReactElement {}

	export interface ShadowComponent<Props> {
		(props: Props): ReactElement;
	}

	export function memo<Value>(value: Value): ShadowComponent<ShadowResolvedProps>;
}
