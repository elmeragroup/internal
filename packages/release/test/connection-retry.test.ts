import { afterEach, describe, expect, it, vi } from "vitest";

import { resendOnDroppedConnection } from "../src/connection-retry.ts";
import { releaseEnvironment } from "../src/environment.ts";

const url = "https://api.github.com/repos/acme/app/releases/1";

// Node's fetch rejects a request on a connection the server already closed with this shape.
function dropped(code: string): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code }) });
}

// A transport that plays `outcomes` in order: an Error rejects, a Response resolves.
function scripted(...outcomes: readonly (Error | Response)[]) {
  let calls = 0;
  const fetch: typeof globalThis.fetch = () => {
    const outcome = outcomes[calls];
    calls += 1;
    if (outcome === undefined) throw new Error("transport called more often than scripted");
    return outcome instanceof Response ? Promise.resolve(outcome) : Promise.reject(outcome);
  };
  return { fetch, calls: () => calls };
}

describe("resending on a dropped connection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["UND_ERR_SOCKET", "EPIPE", "ECONNRESET"])("resends a GET that failed with %s", async (code) => {
    const transport = scripted(dropped(code), new Response("fresh", { status: 200 }));
    const response = await resendOnDroppedConnection(transport.fetch)(url);
    expect(await response.text()).toBe("fresh");
    expect(transport.calls()).toBe(2);
  });

  it("resends the release PATCH", async () => {
    const transport = scripted(dropped("UND_ERR_SOCKET"), new Response("{}", { status: 200 }));
    await resendOnDroppedConnection(transport.fetch)(url, { method: "PATCH", body: "{}" });
    expect(transport.calls()).toBe(2);
  });

  it("never resends a POST", async () => {
    const failure = dropped("UND_ERR_SOCKET");
    const transport = scripted(failure);
    await expect(
      resendOnDroppedConnection(transport.fetch)(url, { method: "POST", body: "{}" })
    ).rejects.toBe(failure);
    expect(transport.calls()).toBe(1);
  });

  it("passes a second drop through", async () => {
    const second = dropped("EPIPE");
    const transport = scripted(dropped("UND_ERR_SOCKET"), second);
    await expect(resendOnDroppedConnection(transport.fetch)(url)).rejects.toBe(second);
    expect(transport.calls()).toBe(2);
  });

  it("passes other network failures and timeouts through", async () => {
    const unresolved = new TypeError("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    });
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    for (const failure of [unresolved, timeout]) {
      const transport = scripted(failure);
      await expect(resendOnDroppedConnection(transport.fetch)(url)).rejects.toBe(failure);
      expect(transport.calls()).toBe(1);
    }
  });

  it("returns an HTTP error status without resending", async () => {
    const transport = scripted(new Response("", { status: 502 }));
    const response = await resendOnDroppedConnection(transport.fetch)(url);
    expect(response.status).toBe(502);
    expect(transport.calls()).toBe(1);
  });

  it("covers the production transport", async () => {
    const transport = scripted(dropped("UND_ERR_SOCKET"), new Response("fresh", { status: 200 }));
    vi.stubGlobal("fetch", transport.fetch);
    const response = await releaseEnvironment().fetch(url);
    expect(await response.text()).toBe("fresh");
    expect(transport.calls()).toBe(2);
  });
});
