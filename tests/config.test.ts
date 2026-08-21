import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("requires credentials and applies safe local defaults", () => {
    const config = loadConfig({
      YAHOO_CLIENT_ID: "client",
      YAHOO_CLIENT_SECRET: "secret",
      XDG_CONFIG_HOME: "/tmp/config-home",
    });
    expect(config.redirectUri).toBe("oob");
    expect(config.scopes).toEqual([]);
    expect(config.tokenPath).toBe(
      "/tmp/config-home/yahoo-fantasy-mcp/token.json",
    );
    expect(config.apiBaseUrl).toBe(
      "https://fantasysports.yahooapis.com/fantasy/v2",
    );
  });

  it("does not fall back to embedded credentials", () => {
    expect(() => loadConfig({})).toThrow("YAHOO_CLIENT_ID is required");
    expect(() => loadConfig({ YAHOO_CLIENT_ID: "id" })).toThrow(
      "YAHOO_CLIENT_SECRET is required",
    );
  });

  it("accepts an explicitly configured OAuth scope", () => {
    const config = loadConfig({
      YAHOO_CLIENT_ID: "id",
      YAHOO_CLIENT_SECRET: "secret",
      YAHOO_SCOPE: "scope-one,scope-two",
    });
    expect(config.scopes).toEqual(["scope-one", "scope-two"]);
  });
});
