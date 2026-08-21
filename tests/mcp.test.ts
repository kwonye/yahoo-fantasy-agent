import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { toolNames } from "../src/mcp/tools.js";
import type { YahooApi } from "../src/mcp/types.js";

interface RecordedCall {
  method: string;
  path: string;
  body?: string | undefined;
}

function yahooMock(calls: RecordedCall[]): YahooApi {
  const response = (method: string, path: string, body?: string) => {
    calls.push({ method, path, body });
    return Promise.resolve({ status: 200, data: { method, path, body } });
  };
  return {
    get: (path) => response("GET", path),
    post: (path, body) => response("POST", path, body),
    put: (path, body) => response("PUT", path, body),
    delete: (path) => response("DELETE", path),
  };
}

const closeCallbacks: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

async function connectedClient(api: YahooApi): Promise<Client> {
  const server = createMcpServer({ yahoo: api });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe("Yahoo Fantasy MCP", () => {
  it("advertises the complete curated tool catalog with accurate annotations", async () => {
    const client = await connectedClient(yahooMock([]));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...toolNames].sort(),
    );
    expect(
      tools.find((tool) => tool.name === "yahoo_user_games")?.annotations,
    ).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(
      tools.find((tool) => tool.name === "yahoo_drop_player")?.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("routes curated reads with Yahoo matrix filters", async () => {
    const calls: RecordedCall[] = [];
    const client = await connectedClient(yahooMock(calls));
    const result = await client.callTool({
      name: "yahoo_league_transactions",
      arguments: {
        leagueKey: "461.l.1000",
        types: "waiver,pending_trade",
        teamKey: "461.l.1000.t.1",
        count: 5,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(calls).toEqual([
      {
        method: "GET",
        path: "league/461.l.1000/transactions;types=waiver,pending_trade;team_key=461.l.1000.t.1;count=5",
        body: undefined,
      },
    ]);
  });

  it("sends exact write methods and XML without a confirmation field", async () => {
    const calls: RecordedCall[] = [];
    const client = await connectedClient(yahooMock(calls));
    await client.callTool({
      name: "yahoo_set_lineup",
      arguments: {
        teamKey: "461.l.1000.t.1",
        coverage: { type: "week", value: 2 },
        players: [{ playerKey: "461.p.1", position: "QB" }],
      },
    });
    await client.callTool({
      name: "yahoo_cancel_transaction",
      arguments: { transactionKey: "461.l.1000.w.c.2" },
    });
    expect(calls[0]).toMatchObject({
      method: "PUT",
      path: "team/461.l.1000.t.1/roster",
    });
    expect(calls[0]?.body).toContain(
      "<coverage_type>week</coverage_type><week>2</week>",
    );
    expect(calls[1]).toEqual({
      method: "DELETE",
      path: "transaction/461.l.1000.w.c.2",
      body: undefined,
    });
  });

  it("rejects malformed tool input before reaching Yahoo", async () => {
    const calls: RecordedCall[] = [];
    const client = await connectedClient(yahooMock(calls));
    const result = await client.callTool({
      name: "yahoo_set_lineup",
      arguments: {
        teamKey: "461.l.1.t.1",
        coverage: { type: "week", value: 0 },
        players: [],
      },
    });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("blocks the advanced GET tool from becoming an authenticated proxy", async () => {
    const calls: RecordedCall[] = [];
    const client = await connectedClient(yahooMock(calls));
    const result = await client.callTool({
      name: "yahoo_advanced_get",
      arguments: { path: "https://evil.example/" },
    });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});
