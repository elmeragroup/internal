/** A documented element carried by every container in this fixture. */
export interface Element {
  /** The element's identifier. */
  id: string;
}

export type ElementAlias = Element;

/** Mutable and readonly arrays, including nested elements and aliases. */
export interface Arrays {
  /** Written with array syntax. */
  mutable: Element[];
  /** Written as a built-in reference. */
  mutableReference: Array<ElementAlias>;
  /** A readonly array written with the type operator. */
  readonlyOperator: readonly Element[];
  /** A readonly array written as a built-in reference. */
  readonlyReference: ReadonlyArray<Element>;
  /** An array of readonly arrays. */
  nested: readonly (readonly Element[])[];
  /** An aliased array keeps its public name. */
  aliased: ElementList;
}

/** A named list of elements. */
export type ElementList = Element[];

/** Tuples with labels, optional elements, rest elements, and readonly state. */
export interface Tuples {
  /** Ordered, unlabelled. */
  plain: [string, Element];
  /** Ordered and labelled. */
  labelled: [first: string, second: Element];
  /** A trailing optional element. */
  optional: [head: string, tail?: number];
  /** A trailing rest element. */
  rest: [head: string, ...tail: Element[]];
  /** A readonly tuple. */
  frozen: readonly [string, number];
  /** An aliased tuple keeps its public name. */
  aliased: Pair;
}

/** A named pair. */
export type Pair = [left: string, right: number];

/** Records and finite mapped-key objects. */
export interface Records {
  /** An open record. */
  open: Record<string, Element>;
  /** A finite mapped key domain resolves to concrete properties. */
  finite: Record<"a" | "b", number>;
  /** A partial mapping over a finite key domain. */
  partial: Partial<Record<"a" | "b", number>>;
}

/** A string index signature with an authored key name. */
export type StringIndexed = { [elementName: string]: Element };

/** A number index signature. */
export type NumberIndexed = { [position: number]: Element };

/** A readonly index signature value. */
export type ReadonlyIndexed = { readonly [elementName: string]: Element };

/** An optional index signature value. */
export type OptionalIndexed = { [elementName: string]: Element | undefined };

/** A symbol index signature has no encoding in the semantic model. */
export type SymbolIndexed = { [key: symbol]: Element };

/** A container whose element type refers back to the container. */
export type RecursiveList = RecursiveNode[];

/** A node inside a recursive list. */
export interface RecursiveNode {
  /** The nodes below this one. */
  children: RecursiveList;
  /** The pair of siblings around this one. */
  siblings: readonly [RecursiveNode, RecursiveNode];
}

/** A mapped alias over an open key domain, whose key is synthesized. */
export type SynthesizedKeys<Key extends string> = {
  [Name in Key]?: Element;
};

/** A mapped alias over a finite key domain, which has concrete properties. */
export type FiniteKeys = {
  [Name in "a" | "b"]?: Element;
};
