import { parseJsonArray, parseJsonObject } from "./lib/json-object.mjs";

export type GitHubObject = ReturnType<typeof parseJsonObject>;

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
  data: (response: Response) => Promise<GitHubObject>;
  items: (response: Response, label: string) => Promise<GitHubObject[]>;
};

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
    data: async (response) => parseJsonObject(await response.text(), "GitHub response"),
    items: async (response, label) => parseJsonArray(await response.text(), label),
  };
}
