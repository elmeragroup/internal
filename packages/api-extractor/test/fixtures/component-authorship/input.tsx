import * as React from "react";

interface TextProps {
  text: string;
}

interface CountProps {
  count: number;
}

interface FlagProps {
  flag: boolean;
}

function TripleRender(props: TextProps): React.ReactElement;
function TripleRender(props: CountProps): React.ReactElement;
function TripleRender(props: FlagProps): React.ReactElement;
function TripleRender(props: TextProps | CountProps | FlagProps): React.ReactElement {
  return <div />;
}

export const TripleWrapped = React.memo(TripleRender);
