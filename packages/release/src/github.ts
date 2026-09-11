import { Schema } from "effect";

import { decodeJson } from "./json.ts";

export const GitHubReleaseAsset = Schema.Struct({
  name: Schema.String,
  id: Schema.Number,
  state: Schema.String,
  size: Schema.Number,
});
export type GitHubReleaseAsset = typeof GitHubReleaseAsset.Type;

export const GitHubRelease = Schema.Struct({
  id: Schema.Number,
  tag_name: Schema.String,
  body: Schema.optionalKey(Schema.NullOr(Schema.String)),
  draft: Schema.optionalKey(Schema.Boolean),
  assets: Schema.Array(GitHubReleaseAsset),
});
export type GitHubRelease = typeof GitHubRelease.Type;

export const GitHubTagRef = Schema.Struct({
  object: Schema.Struct({
    type: Schema.String,
    sha: Schema.String,
  }),
});
export type GitHubTagRef = typeof GitHubTagRef.Type;

export const GitHubPullRequest = Schema.Struct({
  merged_at: Schema.NullOr(Schema.String),
  merge_commit_sha: Schema.NullOr(Schema.String),
  head: Schema.Struct({
    ref: Schema.String,
    repo: Schema.Struct({
      full_name: Schema.String,
    }),
  }),
  base: Schema.Struct({
    ref: Schema.String,
  }),
});
export type GitHubPullRequest = typeof GitHubPullRequest.Type;

export type GitHubRequest = {
  method?: string;
  body?: string | Blob;
  accept?: string;
};

type GitHubRequester = {
  (url: string, options: GitHubRequest & { allow404: true }): Promise<Response | undefined>;
  (url: string, options?: GitHubRequest): Promise<Response>;
};

/** Authenticated GitHub transport: one request shape, plus typed JSON reads of its bodies. */
export type GitHubClient = {
  repository: string;
  root: string;
  uploadRoot: string;
  request: GitHubRequester;
  json: <A>(response: Response, schema: Schema.Codec<A>, label: string) => Promise<A>;
  jsonFrom: <A>(url: string, schema: Schema.Codec<A>, label: string) => Promise<A>;
};

/** Repository and credentials shared by every production port; `fetch` is the injectable transport. */
export type ReleaseEnvironment = {
  repository: string;
  token: string;
  fetch: typeof fetch;
};

/** Reads credentials no earlier than the operation that needs them. */
export function releaseEnvironment(): ReleaseEnvironment {
  return {
    repository: process.env.GITHUB_REPOSITORY ?? "",
    token: process.env.GH_TOKEN ?? "",
    fetch: (input, init) => globalThis.fetch(input, init),
  };
}

export function createGitHubClient(environment: ReleaseEnvironment): GitHubClient {
  const { repository, token, fetch: fetcher } = environment;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || token === "")
    throw new Error("GitHub repository and token are required");

  function request(url: string, options: GitHubRequest & { allow404: true }): Promise<Response | undefined>;
  function request(url: string, options?: GitHubRequest): Promise<Response>;
  async function request(
    url: string,
    options: GitHubRequest & { allow404?: boolean } = {}
  ): Promise<Response | undefined> {
    const method = options.method ?? "GET";
    const headers = new Headers({
      Authorization: `Bearer ${token}`,
      Accept: options.accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(120_000) };
    if (options.body !== undefined) {
      init.body = options.body;
      headers.set("Content-Type", options.body instanceof Blob ? "application/gzip" : "application/json");
    }
    const response = await fetcher(url, init);
    if (options.allow404 === true && response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GitHub ${method} failed: ${String(response.status)} ${url}`);
    return response;
  }

  return {
    repository,
    root: `https://api.github.com/repos/${repository}`,
    uploadRoot: `https://uploads.github.com/repos/${repository}`,
    request,
    json: async (response, schema, label) => decodeJson(await response.text(), schema, label),
    jsonFrom: async (url, schema, label) => decodeJson(await (await request(url)).text(), schema, label),
  };
}
