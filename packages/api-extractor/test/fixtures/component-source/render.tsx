export type RenderProps = {
  label?: string;
};

export function Render({ label = "imported" }: RenderProps) {
  return label ?? null;
}
