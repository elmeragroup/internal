export type PublishedVersion = {
  integrity?: string;
  commit?: string;
};

export type Registry = {
  versions: Map<string, PublishedVersion>;
  tags: Map<string, string>;
};
