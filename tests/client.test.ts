import { describe, expect, it, vi } from "vitest";
import type { YahooConfig } from "../src/config.js";
import { YahooClient } from "../src/yahoo/client.js";
import { YahooError } from "../src/yahoo/errors.js";
import type { YahooToken } from "../src/yahoo/token-store.js";

const config: YahooConfig = {
  clientId: "id",
  clientSecret: "secret",
  redirectUri: "oob",
  scopes: [],
  apiBaseUrl: "https://fantasysports.yahooapis.com/fantasy/v2",
  oauthBaseUrl: "https://api.login.yahoo.com",
  tokenPath: "/tmp/token",
  requestTimeoutMs: 1000,
  maxResponseBytes: 100_000,
  maxGetRetries: 2,
};

const token: YahooToken = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  tokenType: "Bearer",
  expiresAt: Date.now() + 3600_000,
  createdAt: Date.now(),
};

function oauth() {
  return {
    validToken: vi.fn(() => Promise.resolve(token)),
    refresh: vi.fn(() =>
      Promise.resolve({ ...token, accessToken: "refreshed" }),
    ),
  };
}

describe("YahooClient", () => {
  it("parses and normalizes Yahoo XML", async () => {
    const fetchImpl = vi.fn<
      (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(() =>
      Promise.resolve(
        new Response(
          '<fantasy_content refresh_rate="60"><game><game_key>461</game_key><name>Football</name></game></fantasy_content>',
          { status: 200, headers: { "content-type": "application/xml" } },
        ),
      ),
    );
    const client = new YahooClient(config, oauth() as never, { fetchImpl });
    const response = await client.get<{
      fantasy_content: { game: { game_key: string } };
    }>("game/nfl");
    expect(response.data.fantasy_content.game.game_key).toBe("461");
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer access-token",
    });
  });

  it("retries transient reads", async () => {
    const fetchImpl = vi
      .fn<
        (input: string | URL | Request, init?: RequestInit) => Promise<Response>
      >()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(
        new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const sleep = vi.fn(() => Promise.resolve());
    const client = new YahooClient(config, oauth() as never, {
      fetchImpl,
      sleep,
    });
    await expect(client.get("game/nfl")).resolves.toMatchObject({
      data: { ok: true },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("never retries writes", async () => {
    const fetchImpl = vi.fn<
      (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(() => Promise.resolve(new Response("busy", { status: 503 })));
    const client = new YahooClient(config, oauth() as never, {
      fetchImpl,
      sleep: vi.fn(() => Promise.resolve()),
    });
    await expect(
      client.post("league/461.l.1/transactions", "<fantasy_content/>"),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects absolute URLs and redacts bearer tokens in errors", async () => {
    const client = new YahooClient(config, oauth() as never, {
      fetchImpl: vi.fn(),
    });
    await expect(
      client.get("https://evil.example/steal"),
    ).rejects.toMatchObject({ kind: "validation" });
    const error = new YahooError(
      "authentication",
      "Authorization: Bearer top-secret",
    );
    expect(error.message).not.toContain("top-secret");
    const basicError = new YahooError(
      "authentication",
      "Authorization: Basic encoded-client-secret",
    );
    expect(basicError.message).not.toContain("encoded-client-secret");
  });
});
