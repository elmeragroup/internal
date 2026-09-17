/**
 * Declaration merging is legal in either order for an enum and a namespace, and
 * value-first for a function or class merged with a namespace. The value and
 * the namespace members must both appear whichever declaration comes first.
 */
export namespace EnumNamespaceFirst {
  export const member = 1;
}
export enum EnumNamespaceFirst {
  A,
}

export enum EnumValueFirst {
  A,
}
export namespace EnumValueFirst {
  export const member = 1;
}

export function ValueFirst(): void {}
export namespace ValueFirst {
  export const member = 1;
}

export class ClassValueFirst {}
export namespace ClassValueFirst {
  export const member = 1;
}
