import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { AgentService } from "../src/agent/service.js";
import { AgentStore, fingerprint } from "../src/agent/store.js";
import { object, named } from "../src/agent/context.js";
import {
  profileSchema,
  type AgentAction,
  type Scope,
} from "../src/agent/schema.js";
import { createMcpServer } from "../src/mcp/server.js";
import type { YahooApi } from "../src/mcp/types.js";
import type { YahooResponse } from "../src/yahoo/client.js";
import { YahooError } from "../src/yahoo/errors.js";
import { parseAndNormalizeYahooXml } from "../src/yahoo/xml.js";
import { fantasyDataDirectory, loadConfig } from "../src/config.js";

const TEAM = "461.l.100.t.1";
const OTHER = "461.l.100.t.2";
const P1 = "461.p.1",
  P2 = "461.p.2",
  P3 = "461.p.3",
  P4 = "461.p.4";
const scope: Scope = {
  accountGuid: "account-a",
  season: "2026",
  leagueKey: "461.l.100",
  teamKey: TEAM,
};
const profile = profileSchema.parse({
  authority: "full",
  authorization: "User explicitly asked to manage this team for the season",
  format: "redraft",
});
const now = Date.parse("2026-09-14T00:00:00Z");
const evidence = [
  {
    source: "https://sports.yahoo.com/fantasy/",
    observedAt: new Date(now).toISOString(),
    summary: "Current roster and Yahoo eligibility verified",
  },
];
const lineup: AgentAction = {
  tool: "yahoo_set_lineup",
  arguments: {
    teamKey: TEAM,
    coverage: { type: "week", value: 2 },
    players: [
      { playerKey: P2, position: "BN" },
      { playerKey: P3, position: "WR" },
    ],
  },
};
const add: AgentAction = {
  tool: "yahoo_add_player",
  arguments: {
    leagueKey: scope.leagueKey,
    teamKey: TEAM,
    playerKey: P4,
    faabBid: 5,
  },
};

function world() {
  const player = (key: string, position: string, eligible: string[]) => ({
    player_key: key,
    selected_position: { position },
    eligible_positions: { position: eligible },
    is_editable: "1",
    is_undroppable: "0",
  });
  const w = {
    account: "account-a",
    clock: now,
    game: { game_key: "461", season: "2026" },
    league: {
      league_key: scope.leagueKey,
      season: "2026",
      current_week: "2",
      is_finished: "0",
    },
    team: { team_key: TEAM, faab_balance: "50" },
    settings: {
      roster_positions: {
        roster_position: [
          { position: "QB", count: "1" },
          { position: "WR", count: "1" },
          { position: "BN", count: "2" },
          { position: "IR", count: "1" },
        ],
      },
      trade_end_date: "2026-11-20",
    },
    roster: {
      is_editable: "1",
      players: {
        player: [
          player(P1, "QB", ["QB"]),
          player(P2, "WR", ["WR"]),
          player(P3, "BN", ["WR"]),
        ],
      },
    },
    available: "freeagents",
    transactions: [] as Record<string, unknown>[],
    calls: [] as { method: string; path: string; body?: string }[],
    onWrite: undefined as undefined | (() => Promise<YahooResponse>),
  };
  const wrap = (name: string, value: unknown): YahooResponse => ({
    status: 200,
    data: { fantasy_content: { [name]: value } },
  });
  const get: YahooApi["get"] = (path) => {
    w.calls.push({ method: "GET", path });
    if (path.startsWith("users;"))
      return Promise.resolve(
        wrap("users", {
          user: {
            guid: w.account,
            games: { game: { teams: { team: { team_key: TEAM } } } },
          },
        }),
      );
    if (path === "game/nfl")
      return Promise.resolve(wrap("game", structuredClone(w.game)));
    if (path === `league/${scope.leagueKey}`)
      return Promise.resolve(wrap("league", structuredClone(w.league)));
    if (path === `team/${TEAM}`)
      return Promise.resolve(wrap("team", structuredClone(w.team)));
    if (path.includes("/settings"))
      return Promise.resolve(
        wrap("league", { settings: structuredClone(w.settings) }),
      );
    if (path.includes("/roster"))
      return Promise.resolve(
        wrap("team", { roster: structuredClone(w.roster) }),
      );
    if (path.includes("/transactions;"))
      return Promise.resolve(
        wrap("league", {
          transactions: { transaction: structuredClone(w.transactions) },
        }),
      );
    if (path.startsWith("transaction/")) {
      const transaction = w.transactions.find(
        (t) => `transaction/${String(t.transaction_key)}` === path,
      );
      return transaction
        ? Promise.resolve(wrap("transaction", structuredClone(transaction)))
        : Promise.reject(
            new YahooError("not_found", "Missing transaction", { status: 404 }),
          );
    }
    if (path.includes("/players;player_keys=")) {
      const key = path.split("player_keys=")[1]!.split("/")[0]!;
      const owned = w.roster.players.player.find((p) => p.player_key === key);
      const metadata = owned ?? player(key, "BN", ["WR"]);
      return Promise.resolve(
        wrap("league", {
          players: {
            player: {
              ...structuredClone(metadata),
              ownership: owned
                ? { ownership_type: "team", owner_team_key: TEAM }
                : { ownership_type: w.available },
            },
          },
        }),
      );
    }
    return Promise.reject(new Error(`Unexpected GET ${path}`));
  };
  const write = async (
    method: string,
    path: string,
    body?: string,
  ): Promise<YahooResponse> => {
    w.calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    if (w.onWrite) return w.onWrite();
    if (path.includes("/roster")) {
      for (const p of named(parseAndNormalizeYahooXml(body!), "player")) {
        const existing = w.roster.players.player.find(
          (v) => v.player_key === p.player_key,
        )!;
        existing.selected_position.position = String(p.position);
      }
      return wrap("team", { roster: structuredClone(w.roster) });
    }
    const transaction = named(
      parseAndNormalizeYahooXml(body!),
      "transaction",
    )[0]!;
    const receipt = {
      ...transaction,
      transaction_key: "461.l.100.w.c.1",
      status: "pending",
      timestamp: String(w.clock / 1000),
    };
    w.transactions.push(receipt);
    return wrap("transaction", receipt);
  };
  const api: YahooApi = {
    get,
    post: (path, body) => write("POST", path, body),
    put: (path, body) => write("PUT", path, body),
    delete: (path) => write("DELETE", path),
  };
  return { w, api };
}
async function setup() {
  const { w, api } = world();
  const directory = await mkdtemp(join(tmpdir(), "yahoo-agent-test-"));
  const store = new AgentStore(directory);
  const service = new AgentService(api, store, () => w.clock);
  await service.saveProfile(TEAM, "2026", profile);
  const start = object(await service.startRun(TEAM));
  const runId = String(object(start.run).id);
  const prepare = async (action = lineup) =>
    String(
      object(object(await service.prepare(TEAM, runId, action)).preflight).id,
    );
  const execute = async (preflightId: string, id = randomUUID()) =>
    object(
      await service.execute(
        TEAM,
        runId,
        preflightId,
        id,
        "Improves the legal starting lineup",
        evidence,
      ),
    );
  return { w, api, directory, store, service, runId, prepare, execute };
}
const writes = (w: ReturnType<typeof world>["w"]) =>
  w.calls.filter((c) => c.method !== "GET");

describe("autonomous management", () => {
  it("persists an enrolled profile across instances and isolates accounts", async () => {
    const { api, w, store, service } = await setup();
    const restarted = new AgentService(api, store);
    expect(await restarted.getProfile(TEAM)).toMatchObject({
      profile: { authority: "full" },
      scope,
    });
    w.account = "account-b";
    expect(await service.getProfile(TEAM)).toMatchObject({ profile: null });
    await expect(service.startRun(TEAM)).rejects.toThrow("not enrolled");
    await expect(service.getProfile(OTHER)).rejects.toThrow("not owned");
  });
  it("requires new enrollment for a new season and respects pause", async () => {
    const { w, service, prepare } = await setup();
    await service.saveProfile(TEAM, "2026", {
      ...profile,
      authority: "paused",
    });
    await expect(prepare()).rejects.toThrow("not enrolled");
    await expect(service.saveProfile(TEAM, "2025", profile)).rejects.toThrow(
      "season",
    );
    await service.saveProfile(TEAM, "2026", profile);
    w.game.season = "2027";
    await expect(prepare()).rejects.toThrow("current NFL season");
    expect(writes(w)).toHaveLength(0);
  });
  it("sets a full legal swap, verifies positions, and never repeats a decision", async () => {
    const { w, directory, service, runId, prepare, execute } = await setup();
    const preflight = await prepare();
    const id = randomUUID();
    expect(await execute(preflight, id)).toMatchObject({
      action: { status: "verified" },
    });
    expect(await execute(preflight, id)).toMatchObject({ replayed: true });
    expect(writes(w)).toHaveLength(1);
    const file = (await readdir(directory)).find((name) =>
      name.endsWith(".json"),
    )!;
    expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(await readFile(join(directory, file), "utf8")),
    ).toMatchObject({
      actions: [
        {
          id,
          status: "verified",
          rationale: "Improves the legal starting lineup",
        },
      ],
    });
    expect(
      await service.finishRun(TEAM, runId, "Lineup verified"),
    ).toMatchObject({ run: { status: "completed" } });
  });
  it("rejects expired preflights and changed Yahoo state without writing", async () => {
    const { w, prepare, execute } = await setup();
    const id = await prepare();
    w.team.faab_balance = "49";
    await expect(execute(id)).rejects.toThrow("changed after preparation");
    const fresh = await prepare();
    w.clock += 5 * 60_000;
    await expect(execute(fresh)).rejects.toThrow("five minutes");
    expect(writes(w)).toHaveLength(0);
  });
  it.each(["locked", "eligibility", "capacity", "past week"])(
    "preflights %s conflicts",
    async (scenario) => {
      const { w, prepare } = await setup();
      let action = structuredClone(lineup);
      if (scenario === "locked") w.roster.players.player[1]!.is_editable = "0";
      if (scenario === "eligibility")
        w.roster.players.player[2]!.eligible_positions.position = ["QB"];
      if (scenario === "capacity")
        action.arguments.players = [{ playerKey: P3, position: "WR" }];
      if (scenario === "past week")
        action = {
          ...action,
          arguments: {
            ...action.arguments,
            coverage: { type: "week", value: 1 },
          },
        };
      await expect(prepare(action)).rejects.toThrow();
      expect(writes(w)).toHaveLength(0);
    },
  );
  it("validates IR eligibility and active roster capacity independently", async () => {
    const { w, prepare } = await setup();
    const ir: AgentAction = {
      ...lineup,
      arguments: {
        ...lineup.arguments,
        players: [{ playerKey: P2, position: "IR" }],
      },
    };
    await expect(prepare(ir)).rejects.toThrow("eligible");
    w.roster.players.player[1]!.eligible_positions.position.push("IR");
    expect(await prepare(ir)).toBeTypeOf("string");
    w.settings.roster_positions.roster_position.find(
      (p) => p.position === "BN",
    )!.count = "1";
    await expect(prepare(add)).rejects.toThrow("capacity");
  });
  it.each(["protected", "undroppable", "budget", "reserve", "unavailable"])(
    "blocks acquisition conflict: %s",
    async (scenario) => {
      const { w, service, prepare } = await setup();
      const action: AgentAction = {
        tool: "yahoo_add_drop_player",
        arguments: {
          leagueKey: scope.leagueKey,
          teamKey: TEAM,
          addPlayerKey: P4,
          dropPlayerKey: P3,
          faabBid: 5,
        },
      };
      if (scenario === "protected")
        await service.saveProfile(TEAM, "2026", {
          ...profile,
          protectedPlayerKeys: [P3],
        });
      if (scenario === "undroppable")
        w.roster.players.player[2]!.is_undroppable = "1";
      if (scenario === "budget") w.team.faab_balance = "3";
      if (scenario === "reserve")
        await service.saveProfile(TEAM, "2026", {
          ...profile,
          faabReserve: 48,
        });
      if (scenario === "unavailable") w.available = "team";
      await expect(prepare(action)).rejects.toThrow();
      expect(writes(w)).toHaveLength(0);
    },
  );
  it("records a pending waiver receipt as verified submission", async () => {
    const { w, prepare, execute } = await setup();
    w.available = "waivers";
    const result = await execute(await prepare(add));
    expect(result).toMatchObject({
      action: { status: "verified", transactionKeys: ["461.l.100.w.c.1"] },
    });
    expect(w.transactions[0]?.status).toBe("pending");
    expect(writes(w)).toHaveLength(1);
  });
  it("never retries rejected writes, including rate limits", async () => {
    const { w, prepare, execute } = await setup();
    w.onWrite = () =>
      Promise.reject(
        new YahooError("rate_limit", "Rate limited", { status: 429 }),
      );
    const preflight = await prepare();
    const id = randomUUID();
    expect(await execute(preflight, id)).toMatchObject({
      action: { status: "rejected", error: { retryable: false } },
    });
    await execute(preflight, id);
    expect(writes(w)).toHaveLength(1);
  });
  it("recovers a lost response through a new matching transaction without resubmitting", async () => {
    const { w, service, prepare, execute } = await setup();
    w.onWrite = () => {
      const body = writes(w)[0]!.body!;
      w.transactions.push({
        ...named(parseAndNormalizeYahooXml(body), "transaction")[0],
        transaction_key: "461.l.100.w.c.9",
        status: "pending",
        timestamp: String(w.clock / 1000),
      });
      return Promise.reject(
        new YahooError("network", "Connection reset after write"),
      );
    };
    const preflight = await prepare(add);
    const id = randomUUID();
    expect(await execute(preflight, id)).toMatchObject({
      action: { status: "uncertain" },
    });
    await expect(prepare()).rejects.toThrow("reconciliation");
    expect(await service.reconcile(TEAM, id)).toMatchObject({
      action: { status: "verified" },
    });
    await execute(preflight, id);
    expect(writes(w)).toHaveLength(1);
  });
  it("retains uncertainty when no proof exists, including after a process restart", async () => {
    const { w, api, store, service, runId, prepare, execute } = await setup();
    w.onWrite = () => Promise.reject(new YahooError("network", "Timeout"));
    const id = randomUUID();
    const preflight = await prepare(add);
    await execute(preflight, id);
    const restarted = new AgentService(api, store, () => w.clock);
    expect(await restarted.reconcile(TEAM, id)).toMatchObject({
      action: { status: "uncertain" },
    });
    expect(
      await service.finishRun(TEAM, runId, "Needs investigation"),
    ).toMatchObject({ run: { status: "needs_attention" } });
    const start = object(await restarted.startRun(TEAM));
    expect(start.unresolvedActions).toHaveLength(1);
    expect(writes(w)).toHaveLength(1);
  });
  it("handles an interrupted durable intent and concurrent run leases", async () => {
    const { w, api, store, service, runId, prepare } = await setup();
    await expect(
      new AgentService(api, store, () => w.clock).startRun(TEAM),
    ).rejects.toThrow("already active");
    const preflightId = await prepare();
    const id = randomUUID();
    await store.withTeam(scope, async (state, save) => {
      state.actions.push({
        id,
        runId,
        preflight: state.preflights.find((p) => p.id === preflightId)!,
        rationale: "Interrupted after durable intent",
        evidence,
        status: "submitted",
        submittedAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        transactionKeys: [],
      });
      await save();
    });
    w.clock += 31 * 60_000;
    expect(await service.startRun(TEAM)).toMatchObject({
      unresolvedActions: [{ id, status: "submitted" }],
    });
    expect(await service.reconcile(TEAM, id)).toMatchObject({
      action: { status: "uncertain" },
    });
    expect(writes(w)).toHaveLength(0);
  });
  it("holds an interprocess-compatible storage lock and rejects corrupt journals", async () => {
    const { store, directory } = await setup();
    await store.withTeam(scope, async () => {
      await expect(
        new AgentStore(directory).withTeam(scope, () => Promise.resolve()),
      ).rejects.toThrow("storage lock");
    });
    await writeFile(join(directory, `${fingerprint(scope)}.json`), "broken");
    await expect(
      store.withTeam(scope, () => Promise.resolve()),
    ).rejects.toThrow("not been reset");
  });
  it("blocks commissioner actions, foreign trades, and protected outgoing trade assets", async () => {
    const { w, service, prepare } = await setup();
    const key = "461.l.100.pt.7";
    w.transactions.push({
      transaction_key: key,
      type: "pending_trade",
      status: "proposed",
      trader_team_key: OTHER,
      tradee_team_key: TEAM,
      players: {
        player: {
          player_key: P3,
          transaction_data: {
            source_team_key: TEAM,
            destination_team_key: OTHER,
          },
        },
      },
    });
    await expect(
      prepare({
        tool: "yahoo_trade_action",
        arguments: { transactionKey: key, action: "allow" },
      }),
    ).rejects.toThrow("Commissioner");
    await service.saveProfile(TEAM, "2026", {
      ...profile,
      format: "dynasty",
      protectedPlayerKeys: [P3],
    });
    await expect(
      prepare({
        tool: "yahoo_trade_action",
        arguments: { transactionKey: key, action: "accept" },
      }),
    ).rejects.toThrow("protected");
    await expect(
      prepare({
        tool: "yahoo_propose_trade",
        arguments: {
          leagueKey: scope.leagueKey,
          traderTeamKey: OTHER,
          tradeeTeamKey: TEAM,
          players: [
            { playerKey: P3, sourceTeamKey: TEAM, destinationTeamKey: OTHER },
          ],
        },
      }),
    ).rejects.toThrow("originate");
    expect(writes(w)).toHaveLength(0);
  });
  it("exposes typed agent capabilities through an actual MCP client", async () => {
    const { service, api } = await setup();
    const server = createMcpServer({ yahoo: api, agent: service });
    const client = new Client({ name: "agent-test", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const result = await client.callTool({
        name: "yahoo_agent_profile",
        arguments: { teamKey: TEAM },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ scope });
      const invalid = await client.callTool({
        name: "yahoo_agent_execute",
        arguments: { teamKey: "../../other" },
      });
      expect(invalid.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("published runtime configuration", () => {
  it("shares explicit/plugin storage between tokens and agent runs without changing legacy defaults", () => {
    const env = {
      YAHOO_CLIENT_ID: "id",
      YAHOO_CLIENT_SECRET: "secret",
      YAHOO_FANTASY_DATA_DIR: "/tmp/explicit",
      PLUGIN_DATA: "/tmp/plugin",
    };
    expect(fantasyDataDirectory(env)).toBe("/tmp/explicit");
    expect(loadConfig(env).tokenPath).toBe("/tmp/explicit/token.json");
    expect(fantasyDataDirectory({ PLUGIN_DATA: "/tmp/plugin" })).toBe(
      "/tmp/plugin",
    );
    expect(fantasyDataDirectory({ XDG_CONFIG_HOME: "/tmp/xdg" })).toBe(
      "/tmp/xdg/yahoo-fantasy-mcp",
    );
  });
});

describe("claim and transaction follow-through", () => {
  it("detects matching pending claims and reserves FAAB for independent claims", async () => {
    const { w, prepare, execute } = await setup();
    await execute(await prepare(add));
    await expect(prepare(add)).rejects.toThrow("matching pending");
    w.transactions[0]!.type = "waiver";
    w.team.faab_balance = "8";
    await expect(
      prepare({
        ...add,
        arguments: { ...add.arguments, playerKey: "461.p.5" },
      }),
    ).rejects.toThrow("FAAB");
  });
  it("verifies bid edits and cancellation against the existing transaction", async () => {
    const { w, prepare, execute } = await setup();
    await execute(await prepare(add));
    const transaction = w.transactions[0]!;
    transaction.type = "waiver";
    w.onWrite = () => {
      transaction.faab_bid = "7";
      return Promise.resolve({
        status: 200,
        data: { fantasy_content: { transaction } },
      });
    };
    expect(
      await execute(
        await prepare({
          tool: "yahoo_edit_waiver",
          arguments: {
            transactionKey: transaction.transaction_key,
            faabBid: 7,
          },
        }),
      ),
    ).toMatchObject({ action: { status: "verified" } });
    w.onWrite = () => {
      w.transactions = [];
      return Promise.resolve({ status: 200, data: {} });
    };
    expect(
      await execute(
        await prepare({
          tool: "yahoo_cancel_transaction",
          arguments: { transactionKey: transaction.transaction_key },
        }),
      ),
    ).toMatchObject({ action: { status: "verified" } });
    expect(writes(w)).toHaveLength(3);
  });
  it("can reject a trade involving a protected asset without transferring it", async () => {
    const { w, service, prepare, execute } = await setup();
    await service.saveProfile(TEAM, "2026", {
      ...profile,
      protectedPlayerKeys: [P3],
    });
    const transaction = {
      transaction_key: "461.l.100.pt.1",
      type: "pending_trade",
      status: "proposed",
      trader_team_key: OTHER,
      tradee_team_key: TEAM,
      players: {
        player: {
          player_key: P3,
          transaction_data: {
            source_team_key: TEAM,
            destination_team_key: OTHER,
          },
        },
      },
    };
    w.transactions.push(transaction);
    w.onWrite = () => {
      transaction.status = "rejected";
      return Promise.resolve({
        status: 200,
        data: { fantasy_content: { transaction } },
      });
    };
    expect(
      await execute(
        await prepare({
          tool: "yahoo_trade_action",
          arguments: {
            transactionKey: transaction.transaction_key,
            action: "reject",
          },
        }),
      ),
    ).toMatchObject({ action: { status: "verified" } });
    expect(w.roster.players.player.some((p) => p.player_key === P3)).toBe(true);
  });
  it("handles superflex and IDP slots using Yahoo eligibility instead of fixed offensive positions", async () => {
    const { w, prepare } = await setup();
    w.settings.roster_positions.roster_position = [
      { position: "QB", count: "1" },
      { position: "W/R/T/Q", count: "1" },
      { position: "LB", count: "1" },
      { position: "BN", count: "2" },
    ];
    w.roster.players.player[1]!.selected_position.position = "W/R/T/Q";
    w.roster.players.player[1]!.eligible_positions.position = ["QB", "W/R/T/Q"];
    w.roster.players.player[2]!.eligible_positions.position = ["LB", "D"];
    expect(
      await prepare({
        ...lineup,
        arguments: {
          ...lineup.arguments,
          players: [{ playerKey: P3, position: "LB" }],
        },
      }),
    ).toBeTypeOf("string");
    await expect(
      prepare({
        ...lineup,
        arguments: {
          ...lineup.arguments,
          players: [{ playerKey: P3, position: "W/R/T/Q" }],
        },
      }),
    ).rejects.toThrow("eligible");
  });
});
