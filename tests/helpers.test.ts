import { describe, expect, it } from "vitest";
import { errorPayload, matrix, safeAdvancedPath } from "../src/mcp/helpers.js";
import { YahooError } from "../src/yahoo/errors.js";

describe("MCP path helpers", () => {
  it("uses Yahoo matrix parameters without damaging comma-separated values", () => {
    expect(
      matrix("league/461.l.1/transactions", {
        types: "waiver,pending_trade",
        team_key: "461.l.1.t.1",
      }),
    ).toBe(
      "league/461.l.1/transactions;types=waiver,pending_trade;team_key=461.l.1.t.1",
    );
  });

  it("constrains advanced reads to Yahoo Fantasy resources", () => {
    expect(safeAdvancedPath("/fantasy/v2/league/461.l.1/settings")).toBe(
      "league/461.l.1/settings",
    );
    expect(() => safeAdvancedPath("https://evil.example/")).toThrow("relative");
    expect(() => safeAdvancedPath("../oauth2/get_token")).toThrow("resource");
    expect(() => safeAdvancedPath("/fantasy/v2/unknown/path")).toThrow(
      "resource",
    );
  });

  it.each([
    ["configuration", "CONFIGURATION_ERROR", false],
    ["authentication", "AUTH_REQUIRED", false],
    ["token_store", "TOKEN_STORE_ERROR", false],
    ["permission", "FORBIDDEN", false],
    ["validation", "INVALID_ARGUMENT", false],
    ["not_found", "NOT_FOUND", false],
    ["rate_limit", "RATE_LIMITED", true],
    ["network", "NETWORK_ERROR", true],
    ["upstream", "YAHOO_ERROR", true],
    ["parse", "INVALID_RESPONSE", true],
  ] as const)("adds an action for %s failures", (kind, code, retryable) => {
    const payload = errorPayload(new YahooError(kind, "failure"));
    expect(payload).toMatchObject({
      code,
      message: "failure",
      retryable,
    });
    expect(payload.action).toBeTypeOf("string");
  });

  it("redacts secrets while preserving actionable error metadata", () => {
    const payload = errorPayload(
      new YahooError("authentication", "Authorization: Bearer top-secret", {
        status: 401,
        requestId: "request-1",
      }),
    );
    expect(payload).toMatchObject({
      code: "AUTH_REQUIRED",
      retryable: false,
      status: 401,
      requestId: "request-1",
    });
    expect(payload.action).toContain("yahoo-fantasy-mcp auth");
    expect(payload.message).not.toContain("top-secret");
  });
});
