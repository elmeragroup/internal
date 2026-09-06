import { forwardRef, memo } from "react";
import { memo as memoAlias } from "react";

import { Render } from "./render";

export type LabelProps = {
  label?: string;
  options?: { enabled?: boolean };
};

export function DirectFunction({ label = "direct", options: { enabled } = {} }: LabelProps) {
  return label ?? null;
}

export const DirectArrow = ({ label = "arrow" }: LabelProps) => label ?? null;

export function ZeroParameter() {
  return null;
}

export const NestedWrapped = memo(
  forwardRef<unknown, LabelProps>(function NestedWrapped({ label = "nested" }, _ref) {
    return label ?? null;
  })
);

export const AliasWrapped = memoAlias(function AliasWrapped({ label = "alias" }: LabelProps) {
  return label ?? null;
});

export const ImportedWrapped = memo(Render);

export const ExplicitCompound = {
  Root: DirectFunction,
  meta: 1,
};

export const ShorthandCompound = { DirectFunction };

function localMemo<T>(value: T, _compare?: (a: T, b: T) => boolean): T {
  return value;
}

export const FakeMemo = localMemo(function FakeMemo({ label = "fake" }: LabelProps) {
  return label ?? null;
});

export const ComparedWrapped = memo(
  function ComparedWrapped({ label = "compared" }: LabelProps) {
    return label ?? null;
  },
  function comparator({ label: _ignored = "comparator" }: LabelProps) {
    return true;
  }
);

type RenderFn = (props: LabelProps) => string | null;

export const ParenthesizedWrapped = memo((({ label = "paren" }: LabelProps) => label ?? null));

export const AssertionWrapped = memo((({ label = "assert" }: LabelProps) => label ?? null) as RenderFn);

export const SatisfiesWrapped = memo(
  (({ label = "satisfies" }: LabelProps) => label ?? null) satisfies RenderFn
);

export const NonNullWrapped = memo((({ label = "nonnull" }: LabelProps) => label ?? null)!);

export const WrappedOptions = memo(function WrappedOptions({ options: { enabled } = {} }: LabelProps) {
  return enabled ?? null;
});

function OverloadedRender(props: { text?: string }): null;
function OverloadedRender(props: { count?: number }): null;
function OverloadedRender({ text = "overload", count = 0 }: { text?: string; count?: number }) {
  return null;
}

export const OverloadedWrapped = memo(OverloadedRender);

const aliasedRender = DirectFunction;
export const AliasedValue = aliasedRender;

export { DirectFunction as Renamed };

export default DirectFunction;
