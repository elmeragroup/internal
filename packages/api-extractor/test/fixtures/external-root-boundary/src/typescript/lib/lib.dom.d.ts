/** The workspace-owned Array declaration must retain its authored docs. */
interface ProjectArrayBase {
  readonly baseMarker: boolean;
}

/** The workspace-owned Array declaration is not TypeScript's built-in Array. */
export interface Array<T> extends ProjectArrayBase {
  readonly projectMarker: T;
}

export type Extract<T, U> = T extends U ? T : never;
