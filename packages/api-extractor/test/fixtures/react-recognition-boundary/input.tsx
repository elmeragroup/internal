import type { ReactElement, ReactNode } from 'react';
import type * as React from 'react';

/**
 * Workspace-authored recognition-boundary fixture, not an upstream port. It
 * pins the misclassification guards of the basic component transform: mixed
 * unions keep their union kind behind a structured warning, all-component
 * unions still merge, aliased unions lend their name, and lookalike return
 * types never turn an ordinary function into a component.
 */

export interface BadgeProps {
	label: string;
	onSelect: (value: string) => void;
}

export interface PillProps {
	count: number;
}

declare const pickBadge: boolean;
declare const pickPill: boolean;

export declare const badgeFunction: (props: BadgeProps) => ReactElement;
export declare const pillFunction: (props: PillProps) => ReactNode;

/** An arm that is not component-like keeps the whole union untransformed. */
export const MaybeBadge = pickBadge ? badgeFunction : undefined;

/** Every arm component-like: one merged prop table across both forms. */
export const VariantBadge = pickBadge ? badgeFunction : pillFunction;

/** An aliased union lends its own name to the merged component. */
export type VariantAlias =
	| ((props: BadgeProps) => ReactElement)
	| ((props: PillProps) => ReactNode);

declare const aliasedArms: VariantAlias;

export const AliasedVariant = aliasedArms;

/** A signature without a props parameter makes the other forms' props optional. */
export declare const OverloadedBadge: {
	(): ReactElement;
	(props: BadgeProps): ReactElement;
};

/** Lowercase names stay ordinary functions however React-like their returns. */
export declare const useBadgeValue: () => ReactNode;

/**
 * Props squashing keeps a union arm's INTERSECTION whole, mirroring upstream's
 * `unwrapUnionType`: the arm's aggregate properties form one used-set, so
 * `left` and `right` stay required here because every squash entry uses both.
 * Flattening the arm into per-object sets would invent sets missing one of
 * them and wrongly mark both optional.
 */
export declare const IntersectionUnionBadge: {
	(props: (SquashLeft & SquashRight) | SquashPlain): ReactElement;
	(props: SquashPlain): ReactElement;
};

interface SquashLeft {
	left: string;
}

interface SquashRight {
	right: string;
}

interface SquashPlain {
	left: string;
	right: string;
}

/** A bare arrow function bound to an exported constant is recognized as a component. */
export interface ArrowBadgeProps {
	title: string;
}

export const ArrowBadge = (props: ArrowBadgeProps) => <div>{props.title}</div>;

/** A React.FC-annotated arrow variable is recognized through its annotation. */
export interface FcBadgeProps {
	count: number;
}

export const FcBadge: React.FC<FcBadgeProps> = (props) => <span>{props.count}</span>;

/**
 * A children prop lands in the extracted table like any other optional prop.
 * The local ReactNodeChild stands in for `React.ReactNode`: expanding that
 * external graph is what Issue 13/14 adjudicate, so the intent is pinned with
 * the minimal local type that stays representable today.
 */
export interface ChildrenSlotProps {
	children?: ReactNodeChild;
}

type ReactNodeChild = string | number;

export declare const ChildrenSlot: (props: ChildrenSlotProps) => ReactElement;
