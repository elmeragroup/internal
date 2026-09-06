import type * as React from "react";

interface LocalProps {
	localOnly: string;
}

interface LocalComponent {
	(props: LocalProps): React.ReactElement;
}

export declare function memo<Value>(value: Value): LocalComponent;
