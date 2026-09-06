/** The finite tail a generic aliased spread expands to. */
export type Tail<Item> = [Item, number];

/** A tuple whose rest spreads a GENERIC tuple alias with written arguments. */
export type PairedSpread = [boolean, ...Tail<string>];

/** A chained generic spread: the alias refers to another generic tuple alias. */
export type Indirect<Item> = Tail<Item>;

/** A tuple whose rest spreads that indirect generic alias. */
export type IndirectSpread = [...Indirect<number>, boolean];
