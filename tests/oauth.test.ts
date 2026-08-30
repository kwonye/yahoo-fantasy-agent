import { describe, expect, it, vi } from "vitest";
import type { YahooConfig } from "../src/config.js";
import { buildAuthorizationUrl, YahooOAuth } from "../src/yahoo/oauth.js";
import type { YahooToken } from "../src/yahoo/token-store.js";

function config(): YahooConfig {
  return {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "oob",
    scopes: [],
    apiBaseUrl: "https://fantasysports.yahooapis.com/fantasy/v2",
    oauthBaseUrl: "https://api.login.yahoo.com",
    tokenPath: "/tmp/token.json",
    requestTimeoutMs: 1000,
    maxResponseBytes: 100_000,
    maxGetRetries: 2,
  };
}

function memoryStore(initial: YahooToken | null = null) {
  let token = initial;
  return {
    read: vi.fn(() => Promise.resolve(token)),
    write: vi.fn((next: YahooToken) =>
      Promise.resolve().then(() => {
        token = next;
      }),
    ),
    clear: vi.fn(() =>
      Promise.resolve().then(() => {
        token = null;
      }),
    ),
  };
}

function bodyText(body: RequestInit["body"]): string {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return "";
}

describe("Yahoo OAuth", () => {
  it("omits an undocumented scope unless explicitly configured", () => {
    const url = new URL(buildAuthorizationUrl(config(), "state-value"));
    expect(url.searchParams.get("redirect_uri")).toBe("oob");
    expect(url.searchParams.has("scope")).toBe(false);
    expect(url.searchParams.get("state")).toBe("state-value");
  });

  it("exchanges an authorization code without exposing secrets", async () => {
    const fetchImpl = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) => {
        expect(bodyText(init?.body)).toContain("code=auth-code");
        expect(bodyText(init?.body)).not.toContain("client-secret");
        expect(init?.headers).toMatchObject({
          authorization: `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "access",
              refresh_token: "refresh",
              expires_in: 3600,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
        );
      },
    );
    const store = memoryStore();
    const oauth = new YahooOAuth(config(), store as never, {
      fetchImpl,
      now: () => 1_000,
    });
    const token = await oauth.authenticate("auth-code");
    expect(token).toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 3_601_000,
    });
    expect(store.write).toHaveBeenCalledOnce();
  });

  it("coalesces refreshes and keeps the prior refresh token when Yahoo omits one", async () => {
    const store = memoryStore({
      accessToken: "old",
      refreshToken: "refresh",
      tokenType: "Bearer",
      expiresAt: 0,
      createdAt: 0,
    });
    const fetchImpl = vi.fn<
      (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ access_token: "new", expires_in: 3600 }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    const oauth = new YahooOAuth(config(), store as never, {
      fetchImpl,
      now: () => 10_000,
    });
    const [first, second] = await Promise.all([
      oauth.refresh(),
      oauth.refresh(),
    ]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(first.refreshToken).toBe("refresh");
    expect(second.accessToken).toBe("new");
    const refreshInit = fetchImpl.mock.calls[0]?.[1];
    expect(bodyText(refreshInit?.body)).toContain("redirect_uri=oob");
    expect(bodyText(refreshInit?.body)).toContain("refresh_token=refresh");
  });

  it("classifies invalid Yahoo app credentials as configuration errors", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: "invalid_client",
            error_description: "Client credentials are invalid",
          }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    const oauth = new YahooOAuth(config(), memoryStore() as never, {
      fetchImpl,
    });
    await expect(oauth.authenticate("auth-code")).rejects.toMatchObject({
      kind: "configuration",
      status: 401,
    });
  });
});
