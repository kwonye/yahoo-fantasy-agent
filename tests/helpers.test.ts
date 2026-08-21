import { describe, expect, it } from "vitest";
import { matrix, safeAdvancedPath } from "../src/mcp/helpers.js";

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
});
