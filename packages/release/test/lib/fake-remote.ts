import { Redacted, Schema } from "effect";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { ReleaseEnvironment } from "../../src/environment.ts";
import { lift } from "../../src/errors.ts";
import { decodeJson } from "../../src/json.ts";
import type { NpmRunner } from "../../src/npm.ts";

/*
 * One in-memory fake of every remote the release operations reach: GitHub REST, GitHub uploads,
 * the npm registry, and the npm CLI. It models documented behaviour for exactly the routes the
 * engine uses, and any other request fails loudly, naming its method and URL (ADR 0008).
 */

const githubApi = "https://api.github.com";
const githubUploads = "https://uploads.github.com";
const npmRegistry = "https://registry.npmjs.org";

/** One asset on a fake GitHub release; `bytes` is what a download returns. */
export type FakeAsset = {
  readonly id: number;
  readonly name: string;
  readonly state: string;
  readonly size: number;
  readonly bytes: Uint8Array;
};

/** One fake GitHub release, drafts included. */
export type FakeRelease = {
  readonly id: number;
  readonly tag: string;
  readonly name: string;
  readonly body: string | null;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assets: readonly FakeAsset[];
};

/** An asset to seed; omitted fields default to an uploaded `release.tgz` of `bytes`. */
export type SeededAsset = {
  readonly name?: string;
  readonly state?: string;
  readonly size?: number;
  readonly bytes?: Uint8Array;
};

/** A release to seed; omitted fields default to a draft with no body and no assets. */
export type SeededRelease = {
  readonly tag: string;
  readonly body?: string | null;
  readonly draft?: boolean;
  readonly assets?: readonly SeededAsset[];
};

/** The pull-request fields GitHub returns that the stable gate reads. */
export type FakePull = {
  readonly merged_at: string | null;
  readonly merge_commit_sha: string | null;
  readonly head: { readonly ref: string; readonly repo: { readonly full_name: string } };
  readonly base: { readonly ref: string };
};

/** One version in the fake npm packument. */
export type FakeVersion = {
  /** `dist.integrity`; omitted from the packument when absent. */
  readonly integrity?: string;
  /** `elmeraRelease.commit`; the packument has no `elmeraRelease` when absent. */
  readonly commit?: string;
};

/** One request the fake received. */
export type FakeRequest = {
  readonly method: string;
  readonly url: string;
};

/** One archive the fake npm CLI published. */
export type FakePublication = {
  readonly version: string;
  readonly integrity: string;
  readonly archive: string;
  readonly tag: string;
};

/** One npm CLI run: the directory it ran in and its arguments. */
export type FakeNpmCall = {
  readonly cwd: string;
  readonly args: readonly string[];
};

/** The npm commands a test can make fail. */
export type FakeNpmCommand = "publish" | "dist-tag";

type PackumentVersion = {
  readonly name: string;
  readonly version: string;
  readonly dist: { readonly integrity: string | undefined };
  readonly elmeraRelease: { readonly commit: string } | undefined;
};

type MutableRelease = {
  id: number;
  tag: string;
  name: string;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  assets: FakeAsset[];
};

type Override = {
  readonly method: string;
  readonly url: string | RegExp;
  readonly respond: (request: FakeRequest) => Response;
};

const TagRefRequest = Schema.Struct({ ref: Schema.String, sha: Schema.String });
const ReleaseRequest = Schema.Struct({
  tag_name: Schema.String,
  name: Schema.String,
  body: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
});
const ReleasePatch = Schema.Struct({ draft: Schema.optionalKey(Schema.Boolean) });
const PackedManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  elmeraRelease: Schema.optionalKey(Schema.Struct({ commit: Schema.optionalKey(Schema.String) })),
});

const isString = Schema.is(Schema.String);

/** Exposes a live record array without letting tests mutate it. */
function view<T>(items: T[]): readonly T[] {
  return items;
}

/** The integrity npm records for an archive: `sha512-` and the base64 SHA-512 of its bytes. */
export function archiveIntegrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return input;
}

function jsonBody(init: RequestInit | undefined): string {
  const body = init?.body;
  if (!isString(body)) throw new Error("Fake GitHub expected a JSON string body");
  return body;
}

async function blobBody(init: RequestInit | undefined): Promise<Uint8Array> {
  const body = init?.body;
  if (!(body instanceof Blob)) throw new Error("Fake GitHub expected a Blob upload body");
  return new Uint8Array(await body.arrayBuffer());
}

function notFound(): Response {
  return Response.json({ message: "Not Found" }, { status: 404 });
}

function validationFailed(code: string, field: string): Response {
  return Response.json({ message: "Validation Failed", errors: [{ code, field }] }, { status: 422 });
}

function renderAsset(asset: FakeAsset) {
  return {
    id: asset.id,
    name: asset.name,
    state: asset.state,
    size: asset.size,
    content_type: "application/gzip",
  };
}

function renderRelease(release: MutableRelease) {
  return {
    id: release.id,
    tag_name: release.tag,
    name: release.name,
    body: release.body,
    draft: release.draft,
    prerelease: release.prerelease,
    assets: release.assets.map(renderAsset),
  };
}

function npmFailure(message: string): never {
  throw new Error(`npm failed with status 1: ${message}`);
}

/**
 * Builds a fake remote for one repository and one npm package. `environment` is the transport to
 * hand `createReleaseOperations`; the other members seed state, override routes, and inspect what
 * the operations did.
 */
export function createFakeRemote(repository: string, packageName: string) {
  const releases: MutableRelease[] = [];
  const tags = new Map<string, string>();
  const pulls = new Map<string, FakePull[]>();
  const versions = new Map<string, FakeVersion>();
  const distTags = new Map<string, string>();
  const overrides: Override[] = [];
  const npmFailures = new Map<FakeNpmCommand, string>();
  const requests: FakeRequest[] = [];
  const npmCalls: FakeNpmCall[] = [];
  const timeline: string[] = [];
  const published: FakePublication[] = [];
  const promoted: { version: string; tag: string }[] = [];
  const logs: string[] = [];
  let nextId = 1;
  let failingUploads = 0;

  const repoRoot = `${githubApi}/repos/${repository}`;
  const uploadRoot = `${githubUploads}/repos/${repository}`;
  const packumentUrl = `${npmRegistry}/${packageName.replace("/", "%2f")}`;

  function allocateId(): number {
    const id = nextId;
    nextId += 1;
    return id;
  }

  function releaseById(id: number): MutableRelease | undefined {
    return releases.find((release) => release.id === id);
  }

  function seedRelease(seed: SeededRelease): number {
    const id = allocateId();
    releases.push({
      id,
      tag: seed.tag,
      name: seed.tag,
      body: seed.body ?? null,
      draft: seed.draft ?? true,
      prerelease: false,
      assets: (seed.assets ?? []).map((asset) => {
        const bytes = asset.bytes ?? new Uint8Array();
        return {
          id: allocateId(),
          name: asset.name ?? "release.tgz",
          state: asset.state ?? "uploaded",
          size: asset.size ?? bytes.length,
          bytes,
        };
      }),
    });
    return id;
  }

  function listReleases(url: URL): Response {
    // GitHub documents at most 100 results per page and clamps a larger `per_page` to 100.
    const perPage = Math.min(Number(url.searchParams.get("per_page") ?? "30"), 100);
    const page = Number(url.searchParams.get("page") ?? "1");
    // GitHub lists newest first, and includes drafts for a token with push access.
    const newestFirst = [...releases].reverse();
    return Response.json(newestFirst.slice((page - 1) * perPage, page * perPage).map(renderRelease));
  }

  function createRelease(init: RequestInit | undefined): Response {
    const requested = decodeJson(jsonBody(init), ReleaseRequest, "fake release request");
    const published = releases.find((release) => release.tag === requested.tag_name && !release.draft);
    if (published !== undefined) return validationFailed("already_exists", "tag_name");
    const release: MutableRelease = {
      id: allocateId(),
      tag: requested.tag_name,
      name: requested.name,
      body: requested.body,
      draft: requested.draft,
      prerelease: requested.prerelease,
      assets: [],
    };
    releases.push(release);
    return Response.json(renderRelease(release), { status: 201 });
  }

  function updateRelease(release: MutableRelease, init: RequestInit | undefined): Response {
    const patch = decodeJson(jsonBody(init), ReleasePatch, "fake release update");
    if (patch.draft !== undefined) release.draft = patch.draft;
    return Response.json(renderRelease(release));
  }

  function createTag(init: RequestInit | undefined): Response {
    const requested = decodeJson(jsonBody(init), TagRefRequest, "fake ref request");
    const tag = requested.ref.slice("refs/tags/".length);
    if (tags.has(tag)) return validationFailed("already_exists", "ref");
    tags.set(tag, requested.sha);
    return Response.json(
      { ref: requested.ref, object: { type: "commit", sha: requested.sha } },
      { status: 201 }
    );
  }

  function readTag(tag: string): Response {
    const sha = tags.get(tag);
    if (sha === undefined) return notFound();
    return Response.json({ ref: `refs/tags/${tag}`, object: { type: "commit", sha } });
  }

  async function uploadAsset(release: MutableRelease, url: URL, init: RequestInit | undefined) {
    const name = url.searchParams.get("name") ?? "";
    const bytes = await blobBody(init);
    // Documented: a duplicate asset name on the same release is a validation failure.
    if (release.assets.some((asset) => asset.name === name))
      return validationFailed("already_exists", "name");
    if (failingUploads > 0) {
      failingUploads -= 1;
      // Documented: a failed upload may leave an empty asset in state `starter`.
      release.assets.push({ id: allocateId(), name, state: "starter", size: 0, bytes: new Uint8Array() });
      return Response.json({ message: "Bad Gateway" }, { status: 502 });
    }
    const asset: FakeAsset = { id: allocateId(), name, state: "uploaded", size: bytes.length, bytes };
    release.assets.push(asset);
    return Response.json(renderAsset(asset), { status: 201 });
  }

  function findAsset(id: number): { release: MutableRelease; asset: FakeAsset } | undefined {
    for (const release of releases) {
      const asset = release.assets.find((candidate) => candidate.id === id);
      if (asset !== undefined) return { release, asset };
    }
    return undefined;
  }

  function readAsset(id: number, init: RequestInit | undefined): Response {
    const found = findAsset(id);
    if (found === undefined) return notFound();
    if (new Headers(init?.headers).get("accept") === "application/octet-stream") {
      return new Response(new Uint8Array(found.asset.bytes), {
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
    return Response.json(renderAsset(found.asset));
  }

  function deleteAsset(id: number): Response {
    const found = findAsset(id);
    if (found === undefined) return notFound();
    found.release.assets = found.release.assets.filter((asset) => asset !== found.asset);
    return new Response(null, { status: 204 });
  }

  function packument(): Response {
    // An unpublished package is unknown to the registry.
    if (versions.size === 0) return Response.json({ error: "Not found" }, { status: 404 });
    const rendered = [...versions].map(([version, published]): [string, PackumentVersion] => [
      version,
      {
        name: packageName,
        version,
        dist: { integrity: published.integrity },
        elmeraRelease: published.commit === undefined ? undefined : { commit: published.commit },
      },
    ]);
    return Response.json({
      name: packageName,
      "dist-tags": Object.fromEntries(distTags),
      versions: Object.fromEntries(rendered),
    });
  }

  async function route(method: string, url: URL, init: RequestInit | undefined): Promise<Response> {
    const href = url.href;
    if (href.startsWith(`${npmRegistry}/`)) {
      if (method === "GET") return href === packumentUrl ? packument() : notFound();
    } else if (href.startsWith(`${uploadRoot}/`)) {
      const upload = /^\/releases\/(\d+)\/assets$/.exec(url.pathname.slice(`/repos/${repository}`.length));
      if (method === "POST" && upload !== null) {
        const release = releaseById(Number(upload[1]));
        return release === undefined ? notFound() : uploadAsset(release, url, init);
      }
    } else if (href.startsWith(`${repoRoot}/`)) {
      const path = url.pathname.slice(`/repos/${repository}`.length);
      if (path === "/releases" && method === "GET") return listReleases(url);
      if (path === "/releases" && method === "POST") return createRelease(init);
      const asset = /^\/releases\/assets\/(\d+)$/.exec(path);
      if (asset !== null && method === "GET") return readAsset(Number(asset[1]), init);
      if (asset !== null && method === "DELETE") return deleteAsset(Number(asset[1]));
      const byId = /^\/releases\/(\d+)$/.exec(path);
      if (byId !== null && (method === "GET" || method === "PATCH")) {
        const release = releaseById(Number(byId[1]));
        if (release === undefined) return notFound();
        return method === "GET" ? Response.json(renderRelease(release)) : updateRelease(release, init);
      }
      const tagRef = /^\/git\/ref\/tags\/(.+)$/.exec(path);
      if (tagRef !== null && method === "GET") return readTag(decodeURIComponent(tagRef[1] ?? ""));
      if (path === "/git/refs" && method === "POST") return createTag(init);
      const commitPulls = /^\/commits\/([a-f0-9]+)\/pulls$/.exec(path);
      if (commitPulls !== null && method === "GET")
        return Response.json(pulls.get(commitPulls[1] ?? "") ?? []);
    }
    throw new Error(`Fake remote has no route for ${method} ${href}`);
  }

  const fakeFetch: typeof fetch = async (input, init) => {
    const request: FakeRequest = { method: (init?.method ?? "GET").toUpperCase(), url: requestUrl(input) };
    requests.push(request);
    timeline.push(`${request.method} ${request.url}`);
    const override = overrides.find(
      (candidate) =>
        candidate.method === request.method &&
        (candidate.url instanceof RegExp ? candidate.url.test(request.url) : candidate.url === request.url)
    );
    if (override !== undefined) return override.respond(request);
    return route(request.method, new URL(request.url), init);
  };

  function publish(args: readonly string[]): void {
    const archive = args[1] ?? "";
    const tagIndex = args.indexOf("--tag");
    const tag = tagIndex === -1 ? "latest" : (args[tagIndex + 1] ?? "latest");
    const bytes = new Uint8Array(readFileSync(archive));
    const manifest = decodeJson(
      execFileSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" }),
      PackedManifest,
      "fake npm packed manifest"
    );
    if (manifest.name !== packageName) npmFailure(`E404 ${manifest.name} is not ${packageName}`);
    if (versions.has(manifest.version)) {
      npmFailure(`E403 You cannot publish over the previously published versions: ${manifest.version}`);
    }
    const integrity = archiveIntegrity(bytes);
    const commit = manifest.elmeraRelease?.commit;
    versions.set(manifest.version, commit === undefined ? { integrity } : { integrity, commit });
    distTags.set(tag, manifest.version);
    published.push({ version: manifest.version, integrity, archive, tag });
  }

  function addDistTag(args: readonly string[]): void {
    const spec = args[2] ?? "";
    const tag = args[3] ?? "";
    const separator = spec.lastIndexOf("@");
    const name = spec.slice(0, separator);
    const version = spec.slice(separator + 1);
    if (name !== packageName || !versions.has(version)) npmFailure(`E404 ${spec} is not in the registry`);
    distTags.set(tag, version);
    promoted.push({ version, tag });
  }

  const npm: NpmRunner = (cwd, args) =>
    lift(() => {
      npmCalls.push({ cwd, args: [...args] });
      timeline.push(`npm ${args.join(" ")}`);
      const command: FakeNpmCommand | undefined =
        args[0] === "publish"
          ? "publish"
          : args[0] === "dist-tag" && args[1] === "add"
            ? "dist-tag"
            : undefined;
      if (command === undefined) throw new Error(`Fake npm has no command ${args.join(" ")}`);
      const failure = npmFailures.get(command);
      if (failure !== undefined) {
        npmFailures.delete(command);
        npmFailure(failure);
      }
      if (command === "publish") publish(args);
      else addDistTag(args);
    });

  const environment: ReleaseEnvironment = {
    repository,
    token: Redacted.make("fake-token"),
    fetch: fakeFetch,
    npm,
    log: (message) => {
      logs.push(message);
    },
  };

  function snapshot(release: MutableRelease): FakeRelease {
    return { ...release, assets: [...release.assets] };
  }

  return {
    environment,
    /** Every request received, in order. */
    requests: view(requests),
    /** Every npm CLI run received, with its working directory, in order. */
    npmCalls: view(npmCalls),
    /** GitHub and registry requests (`METHOD url`) and npm runs (`npm args`), in one order. */
    timeline: view(timeline),
    /** Archives the fake npm CLI accepted. */
    published: view(published),
    /** Dist-tag updates the fake npm CLI accepted. */
    promoted: view(promoted),
    /** Messages the operations logged. */
    logs: view(logs),
    /** Adds a release (draft by default) and returns its id. */
    seedRelease,
    /** Points a tag ref at `sha`. */
    seedTag: (tag: string, sha: string): void => {
      tags.set(tag, sha);
    },
    /** Associates a pull request with a commit. */
    seedPull: (commit: string, pull: FakePull): void => {
      pulls.set(commit, [...(pulls.get(commit) ?? []), pull]);
    },
    /** Adds a published version to the npm registry. */
    seedVersion: (version: string, published: FakeVersion): void => {
      versions.set(version, published);
    },
    /** Points an npm dist-tag at a version. */
    seedDistTag: (tag: string, version: string): void => {
      distTags.set(tag, version);
    },
    /** Answers every matching request with `respond` instead of the modelled route. */
    override: (method: string, url: string | RegExp, respond: (request: FakeRequest) => Response): void => {
      overrides.push({ method, url, respond });
    },
    /** Fails the next upload with a 502, leaving an empty `starter` asset as GitHub documents. */
    failNextUpload: (): void => {
      failingUploads += 1;
    },
    /** Makes the next run of an npm command fail with `message` on stderr. */
    failNextNpm: (command: FakeNpmCommand, message: string): void => {
      npmFailures.set(command, message);
    },
    /** Requests other than GET, in order, rendered `METHOD url`. */
    mutations: (): string[] =>
      requests
        .filter((request) => request.method !== "GET")
        .map((request) => `${request.method} ${request.url}`),
    /** How many requests matched `method` and a URL containing `fragment`. */
    count: (method: string, fragment: string): number =>
      requests.filter((request) => request.method === method && request.url.includes(fragment)).length,
    /** The single release carrying `tag`; throws when there is none or more than one. */
    release: (tag: string): FakeRelease => {
      const matches = releases.filter((release) => release.tag === tag);
      const [only] = matches;
      if (only === undefined || matches.length !== 1) {
        throw new Error(`Expected one fake release for ${tag}; found ${String(matches.length)}`);
      }
      return snapshot(only);
    },
    /** The commit a tag ref points at. */
    tag: (tag: string): string | undefined => tags.get(tag),
    /** One registry version, as the packument now records it. */
    version: (version: string): FakeVersion | undefined => versions.get(version),
    /** The registry's dist-tags. */
    distTags: (): ReadonlyMap<string, string> => new Map(distTags),
  };
}

/** A fake remote built by {@link createFakeRemote}. */
export type FakeRemote = ReturnType<typeof createFakeRemote>;
