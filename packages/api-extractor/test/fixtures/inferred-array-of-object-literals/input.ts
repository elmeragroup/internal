/**
 * Inferred root-level container elements, compared with the same shapes in
 * inferred function return position. None of these values has authored type
 * syntax, so each shape is anchored only by where it appears.
 */
export const values = [{ a: 1 }];

export function returnsObject() {
  return { a: 1 };
}

export function returnsArray() {
  return [{ a: 1 }];
}
