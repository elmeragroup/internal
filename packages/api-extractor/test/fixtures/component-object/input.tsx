import type { ReactElement, ReactNode } from 'react';

/**
 * Workspace-authored fixture for the object-of-components shape:
 * `export const Menu = { Root, Item }` is a module value whose every member
 * is a React component. The model describes it as an object whose properties
 * are components instead of degrading the whole value to `any`.
 */

export interface MenuRootProps {
	/** Whether the menu starts open. */
	open?: boolean;
	children?: ReactNode;
}

export interface MenuItemProps {
	value: string;
	disabled?: boolean;
}

/** The root of the menu compound. */
function MenuRoot(props: MenuRootProps): ReactElement {
	return <div data-open={props.open}>{props.children}</div>;
}

function MenuItem({ value, disabled = false }: MenuItemProps): ReactElement {
	return <div data-disabled={disabled}>{value}</div>;
}

function helper(): number {
	return 1;
}

export const Menu = {
	Root: MenuRoot,
	Item: MenuItem,
};

/** A module value mixing a component with plain data is not a component object. */
export const mixed = {
	Root: MenuRoot,
	count: helper(),
};
