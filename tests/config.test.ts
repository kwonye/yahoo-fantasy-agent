import { describe, expect, it } from "vitest";
import { loadConfig, loadHttpConfig } from "../src/config.js";

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

  it("resolves safe Streamable HTTP defaults", () => {
    const config = loadHttpConfig({});
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 3000,
      path: "/mcp",
      responseMode: "auto",
    });
    expect(config.allowedHosts).toContain("localhost");
  });

  it("requires a token and allowed hosts for non-loopback HTTP", () => {
    expect(() => loadHttpConfig({ MCP_HTTP_HOST: "0.0.0.0" })).toThrow(
      "MCP_HTTP_TOKEN",
    );
    expect(() =>
      loadHttpConfig({
        MCP_HTTP_HOST: "0.0.0.0",
        MCP_HTTP_TOKEN: "secret",
      }),
    ).toThrow("MCP_HTTP_ALLOWED_HOSTS");
    expect(
      loadHttpConfig({
        MCP_HTTP_HOST: "0.0.0.0",
        MCP_HTTP_TOKEN: "secret",
        MCP_HTTP_ALLOWED_HOSTS: "mcp.example.com",
      }),
    ).toMatchObject({
      host: "0.0.0.0",
      token: "secret",
      allowedHosts: ["mcp.example.com"],
    });
  });

  it("validates HTTP endpoint and response mode", () => {
    expect(() => loadHttpConfig({ MCP_HTTP_PATH: "mcp" })).toThrow(
      "start with /",
    );
    expect(() => loadHttpConfig({ MCP_HTTP_RESPONSE_MODE: "xml" })).toThrow(
      "response mode",
    );
    expect(() => loadHttpConfig({ MCP_HTTP_PORT: "70000" })).toThrow(
      "between 0 and 65535",
    );
  });
});
