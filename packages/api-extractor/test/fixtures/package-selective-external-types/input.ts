import type { PrimitiveProps, SelectedKeySource } from "@fixture/selected/button";
import type { ExtraProps } from "@fixture/selected-extra";
import type { ForeignKeySource, ForeignMapped } from "fixture-unselected";
import type * as React from "react";
import type { UnknownOwner } from "unknown-owner";

export interface WrapperProps extends PrimitiveProps, ExtraProps {
  localLabel: string;
}

export interface UnknownOwnerWrapper {
  unknownOwner: UnknownOwner;
}

export declare function PrimitiveComponent(props: WrapperProps): React.ReactElement;
export declare const WrappedComponent: React.FC<WrapperProps>;

export type SelectedMappedUse = import("@fixture/selected/button").SelectedMapped;
export type SelectedKeysUse = keyof SelectedKeySource;
export type UnselectedMappedUse = ForeignMapped;
export type UnselectedKeysUse = keyof ForeignKeySource;
export type SelectedUtilityUse = Pick<WrapperProps, "focusableWhenDisabled" | "localLabel">;
export type { MixedOwner, SelectedOwner } from "@fixture/selected/button";
