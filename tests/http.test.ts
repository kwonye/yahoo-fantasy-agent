import { request as httpRequest } from "node:http";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadHttpConfig } from "../src/config.js";
import { serveYahooFantasyHttp } from "../src/http.js";
import type { McpRuntime, YahooApi } from "../src/mcp/types.js";

const handles: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

function runtime(): McpRuntime {
  const yahoo: YahooApi = {
    get: (path) =>
      Promise.resolve({ status: 200, data: { method: "GET", path } }),
    post: (path, body) =>
      Promise.resolve({ status: 200, data: { method: "POST", path, body } }),
    put: (path, body) =>
      Promise.resolve({ status: 200, data: { method: "PUT", path, body } }),
    delete: (path) =>
      Promise.resolve({ status: 200, data: { method: "DELETE", path } }),
  };
  return { yahoo };
}

async function start(overrides: Parameters<typeof loadHttpConfig>[1] = {}) {
  const handle = await serveYahooFantasyHttp(runtime(), {
    config: loadHttpConfig({}, { host: "127.0.0.1", port: 0, ...overrides }),
  });
  handles.push(handle);
  return handle;
}

function rawStatus(url: URL, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

describe("MCP v2 Streamable HTTP", () => {
  it("negotiates the modern era and serves the complete tool catalog", async () => {
    const handle = await start();
    const client = new Client(
      { name: "http-modern-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    const transport = new StreamableHTTPClientTransport(handle.url);
    await client.connect(transport);
    try {
      expect(client.getProtocolEra()).toBe("modern");
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(40);
      expect(
        tools.find((tool) => tool.name === "yahoo_user_games"),
      ).toMatchObject({
        outputSchema: { type: "object" },
      });
      const result = await client.callTool({
        name: "yahoo_user_games",
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        method: "GET",
        path: "users;use_login=1/games",
      });
    } finally {
      await client.close();
    }
  });

  it("keeps the legacy 2025 handshake available on the same endpoint", async () => {
    const handle = await start();
    const client = new Client({ name: "http-legacy-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(handle.url));
    try {
      expect(client.getProtocolEra()).toBe("legacy");
      expect((await client.listTools()).tools.length).toBeGreaterThan(40);
    } finally {
      await client.close();
    }
  });

  it("serves every response as SSE when requested", async () => {
    const handle = await start({ responseMode: "sse" });
    const client = new Client(
      { name: "http-sse-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(new StreamableHTTPClientTransport(handle.url));
    try {
      expect((await client.listTools()).tools.length).toBeGreaterThan(40);
    } finally {
      await client.close();
    }
  });

  it("supports JSON-only response mode", async () => {
    const handle = await start({ responseMode: "json" });
    const client = new Client(
      { name: "http-json-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(new StreamableHTTPClientTransport(handle.url));
    try {
      expect((await client.listTools()).tools.length).toBeGreaterThan(40);
    } finally {
      await client.close();
    }
  });

  it("enforces bearer auth and endpoint routing", async () => {
    const handle = await start({ token: "test-secret" });
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "raw-test", version: "1.0.0" },
      },
    });
    const unauthorized = await fetch(handle.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("Bearer");

    const authorized = await fetch(handle.url, {
      method: "POST",
      headers: {
        authorization: "Bearer test-secret",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body,
    });
    expect(authorized.status).toBe(200);
    expect((await fetch(new URL("/wrong", handle.url))).status).toBe(404);
  });

  it("does not allow a programmatic remote bind to bypass validation", async () => {
    await expect(
      serveYahooFantasyHttp(runtime(), {
        config: {
          host: "0.0.0.0",
          port: 0,
          path: "/mcp",
          responseMode: "auto",
          allowedHosts: [],
          allowedOrigins: [],
        },
      }),
    ).rejects.toThrow("MCP_HTTP_TOKEN");
  });

  it("rejects a hostile Host header before MCP dispatch", async () => {
    const handle = await start();
    expect(await rawStatus(handle.url, { host: "evil.example" })).toBe(403);
    const response = await fetch(handle.url, {
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
  });

  it("returns a protocol error for malformed MCP requests", async () => {
    const handle = await start();
    const response = await fetch(handle.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(response.status).toBe(400);
  });

  it("closes active handler state and the listening socket", async () => {
    const handle = await start();
    await handle.close();
    await expect(handle.closed).resolves.toBeUndefined();
    await expect(fetch(handle.url)).rejects.toThrow();
  });
});
