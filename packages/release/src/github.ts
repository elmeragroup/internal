import { Schema } from "effect";

import { decodeJson, decodeJsonArray, decodeUnknown } from "./json.ts";

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
  body: Schema.optionalKey(Schema.Json),
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
  merged_at: Schema.Json,
  merge_commit_sha: Schema.optionalKey(Schema.Json),
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

/** Authenticated GitHub transport: one request shape, plus the two response shapes callers read. */
export type GitHubClient = {
  repository: string;
  root: string;
  uploadRoot: string;
  request: GitHubRequester;
  data: (response: Response) => Promise<Schema.Json>;
  items: (response: Response, label: string) => Promise<readonly Schema.Json[]>;
};

export function decodeGitHubRelease(value: Schema.Json, label: string): GitHubRelease {
  return decodeUnknown(value, GitHubRelease, label);
}

export function decodeGitHubTagRef(value: Schema.Json, label: string): GitHubTagRef {
  return decodeUnknown(value, GitHubTagRef, label);
}

export function decodeGitHubPullRequest(value: Schema.Json, label: string): GitHubPullRequest {
  return decodeUnknown(value, GitHubPullRequest, label);
}

export function createGitHubClient(
  repository: string,
  token: string,
  fetcher: typeof fetch = fetch
): GitHubClient {
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
    data: async (response) => decodeJson(await response.text(), Schema.Json, "GitHub response"),
    items: async (response, label) => decodeJsonArray(await response.text(), Schema.Json, label),
  };
}
