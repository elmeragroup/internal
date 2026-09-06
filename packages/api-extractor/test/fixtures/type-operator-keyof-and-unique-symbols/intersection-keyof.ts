export interface Layout {
	width: number;
}

export interface Style {
	color: string;
}

export type Combined = Layout & Style;

export type CombinedKeys = keyof (Layout & Style);
