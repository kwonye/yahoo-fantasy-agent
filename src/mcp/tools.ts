import type {
  McpServer,
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  buildRosterPayload,
  buildTradePayload,
  buildTransactionActionPayload,
  buildTransactionPayload,
  buildWaiverEditPayload,
} from "../yahoo/writes.js";
import {
  appendQuery,
  matrix,
  resourcePath,
  safeAdvancedPath,
  safely,
  userPath,
} from "./helpers.js";
import type { McpRuntime, YahooApi } from "./types.js";

const nonEmpty = z.string().trim().min(1);
const gameKey = nonEmpty.describe("Yahoo game key, such as nfl or 461");
const leagueKey = nonEmpty.describe("Yahoo league key, such as 461.l.1000");
const teamKey = nonEmpty.describe("Yahoo team key, such as 461.l.1000.t.1");
const playerKey = nonEmpty.describe("Yahoo player key, such as 461.p.30121");
const transactionKey = nonEmpty.describe(
  "Yahoo transaction, waiver-claim, or pending-trade key",
);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Date in YYYY-MM-DD format");
const pagination = {
  start: z.number().int().nonnegative().optional(),
  count: z.number().int().positive().max(500).optional(),
};

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

function title(name: string): string {
  return name
    .split("_")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function add<S extends z.ZodObject<z.ZodRawShape>>(
  server: McpServer,
  name: string,
  description: string,
  schema: S,
  handler: (args: z.infer<S>) => Promise<unknown>,
  write = false,
): void {
  const registerTool = server.registerTool.bind(server) as unknown as (
    toolName: string,
    config: {
      title: string;
      description: string;
      inputSchema: z.ZodType;
      annotations: ToolAnnotations;
    },
    callback: (args: Record<string, unknown>) => Promise<CallToolResult>,
  ) => unknown;
  registerTool(
    name,
    {
      title: title(name),
      description,
      inputSchema: schema,
      annotations: write ? writeAnnotations : readAnnotations,
    },
    async (args) => safely(() => handler(args as z.infer<S>)),
  );
}

function coverage(args: {
  week?: number | undefined;
  date?: string | undefined;
}): Record<string, unknown> {
  if (args.week !== undefined && args.date !== undefined)
    throw new Error("Provide week or date, not both");
  if (args.week !== undefined) return { type: "week", week: args.week };
  if (args.date !== undefined) return { type: "date", date: args.date };
  return {};
}

function registerReadTools(server: McpServer, api: YahooApi): void {
  const empty = z.object({}).strict();
  add(
    server,
    "yahoo_user_games",
    "List games for the authenticated Yahoo user.",
    empty,
    () => api.get(userPath("games")),
  );
  const userFilter = z.object({ gameKeys: nonEmpty.optional() }).strict();
  add(
    server,
    "yahoo_user_leagues",
    "List the authenticated user's leagues, optionally filtered by comma-separated game keys.",
    userFilter,
    ({ gameKeys }) => {
      const games = matrix(userPath("games"), { game_keys: gameKeys });
      return api.get(`${games}/leagues`);
    },
  );
  add(
    server,
    "yahoo_user_teams",
    "List the authenticated user's teams, optionally filtered by comma-separated game keys.",
    userFilter,
    ({ gameKeys }) => {
      const games = matrix(userPath("games"), { game_keys: gameKeys });
      return api.get(`${games}/teams`);
    },
  );

  const game = z.object({ gameKey }).strict();
  add(server, "yahoo_game", "Get game metadata.", game, ({ gameKey: value }) =>
    api.get(resourcePath("game", value)),
  );
  add(
    server,
    "yahoo_game_dates",
    "Get key dates for a game.",
    game,
    ({ gameKey: value }) => api.get(resourcePath("game", value, "dates")),
  );
  add(
    server,
    "yahoo_game_weeks",
    "Get fantasy weeks and their dates for a game.",
    game,
    ({ gameKey: value }) => api.get(resourcePath("game", value, "game_weeks")),
  );
  add(
    server,
    "yahoo_game_stat_categories",
    "Get stat categories for a game.",
    game,
    ({ gameKey: value }) =>
      api.get(resourcePath("game", value, "stat_categories")),
  );
  add(
    server,
    "yahoo_game_position_types",
    "Get player position types for a game.",
    game,
    ({ gameKey: value }) =>
      api.get(resourcePath("game", value, "position_types")),
  );
  add(
    server,
    "yahoo_game_roster_positions",
    "Get valid roster positions for a game.",
    game,
    ({ gameKey: value }) =>
      api.get(resourcePath("game", value, "roster_positions")),
  );
  const gameLeagues = z
    .object({ gameKey, leagueKeys: nonEmpty.optional(), ...pagination })
    .strict();
  add(
    server,
    "yahoo_game_leagues",
    "List selected leagues within a game.",
    gameLeagues,
    (args) =>
      api.get(
        matrix(resourcePath("game", args.gameKey, "leagues"), {
          league_keys: args.leagueKeys,
          start: args.start,
          count: args.count,
        }),
      ),
  );
  const playerSearch = {
    status: nonEmpty.optional(),
    search: nonEmpty.optional(),
    position: nonEmpty.optional(),
    sort: nonEmpty.optional(),
    ...pagination,
  };
  const gamePlayers = z.object({ gameKey, ...playerSearch }).strict();
  add(
    server,
    "yahoo_game_players",
    "Search or list players in a game.",
    gamePlayers,
    (args) =>
      api.get(
        matrix(resourcePath("game", args.gameKey, "players"), {
          status: args.status,
          search: args.search,
          position: args.position,
          sort: args.sort,
          start: args.start,
          count: args.count,
        }),
      ),
  );

  const league = z.object({ leagueKey }).strict();
  add(
    server,
    "yahoo_league",
    "Get league metadata.",
    league,
    ({ leagueKey: value }) => api.get(resourcePath("league", value)),
  );
  add(
    server,
    "yahoo_league_settings",
    "Get draft, scoring, roster, stat, and division settings for a league.",
    league,
    ({ leagueKey: value }) =>
      api.get(resourcePath("league", value, "settings")),
  );
  add(
    server,
    "yahoo_league_standings",
    "Get league standings and team records.",
    league,
    ({ leagueKey: value }) =>
      api.get(resourcePath("league", value, "standings")),
  );
  const scoreboard = z
    .object({ leagueKey, week: z.number().int().positive().optional() })
    .strict();
  add(
    server,
    "yahoo_league_scoreboard",
    "Get a league scoreboard for the current or selected week.",
    scoreboard,
    ({ leagueKey: value, week }) =>
      api.get(matrix(resourcePath("league", value, "scoreboard"), { week })),
  );
  const leagueTeams = z
    .object({ leagueKey, teamKeys: nonEmpty.optional(), ...pagination })
    .strict();
  add(
    server,
    "yahoo_league_teams",
    "List teams in a league.",
    leagueTeams,
    (args) =>
      api.get(
        matrix(resourcePath("league", args.leagueKey, "teams"), {
          team_keys: args.teamKeys,
          start: args.start,
          count: args.count,
        }),
      ),
  );
  const leaguePlayers = z.object({ leagueKey, ...playerSearch }).strict();
  add(
    server,
    "yahoo_league_players",
    "Search or list players eligible in a league.",
    leaguePlayers,
    (args) =>
      api.get(
        matrix(resourcePath("league", args.leagueKey, "players"), {
          status: args.status,
          search: args.search,
          position: args.position,
          sort: args.sort,
          start: args.start,
          count: args.count,
        }),
      ),
  );
  add(
    server,
    "yahoo_league_draft_results",
    "Get all draft results for a league.",
    league,
    ({ leagueKey: value }) =>
      api.get(resourcePath("league", value, "draftresults")),
  );
  const transactions = z
    .object({
      leagueKey,
      type: nonEmpty.optional(),
      types: nonEmpty.optional(),
      teamKey: teamKey.optional(),
      ...pagination,
    })
    .strict();
  add(
    server,
    "yahoo_league_transactions",
    "List completed or team-visible pending league transactions.",
    transactions,
    (args) =>
      api.get(
        matrix(resourcePath("league", args.leagueKey, "transactions"), {
          type: args.type,
          types: args.types,
          team_key: args.teamKey,
          start: args.start,
          count: args.count,
        }),
      ),
  );

  const team = z.object({ teamKey }).strict();
  add(server, "yahoo_team", "Get team metadata.", team, ({ teamKey: value }) =>
    api.get(resourcePath("team", value)),
  );
  const teamCoverage = z
    .object({
      teamKey,
      week: z.number().int().positive().optional(),
      date: date.optional(),
    })
    .strict();
  add(
    server,
    "yahoo_team_stats",
    "Get team stats for a week or date.",
    teamCoverage,
    (args) =>
      api.get(
        matrix(resourcePath("team", args.teamKey, "stats"), coverage(args)),
      ),
  );
  add(
    server,
    "yahoo_team_standings",
    "Get a team's standings record.",
    team,
    ({ teamKey: value }) => api.get(resourcePath("team", value, "standings")),
  );
  add(
    server,
    "yahoo_team_roster",
    "Get a team's current, weekly, or dated roster.",
    teamCoverage,
    (args) =>
      api.get(
        matrix(resourcePath("team", args.teamKey, "roster"), {
          week: args.week,
          date: args.date,
        }),
      ),
  );
  add(
    server,
    "yahoo_team_draft_results",
    "Get players drafted by a team.",
    team,
    ({ teamKey: value }) =>
      api.get(resourcePath("team", value, "draftresults")),
  );
  const matchups = z.object({ teamKey, weeks: nonEmpty.optional() }).strict();
  add(
    server,
    "yahoo_team_matchups",
    "Get all or selected comma-separated matchup weeks for a team.",
    matchups,
    ({ teamKey: value, weeks }) =>
      api.get(matrix(resourcePath("team", value, "matchups"), { weeks })),
  );

  const player = z.object({ playerKey }).strict();
  add(
    server,
    "yahoo_player",
    "Get player metadata.",
    player,
    ({ playerKey: value }) => api.get(resourcePath("player", value)),
  );
  const playerCoverage = z
    .object({
      playerKey,
      week: z.number().int().positive().optional(),
      date: date.optional(),
    })
    .strict();
  add(
    server,
    "yahoo_player_stats",
    "Get player stats for a week or date.",
    playerCoverage,
    (args) =>
      api.get(
        matrix(resourcePath("player", args.playerKey, "stats"), coverage(args)),
      ),
  );
  add(
    server,
    "yahoo_player_ownership",
    "Get a player's ownership data.",
    player,
    ({ playerKey: value }) =>
      api.get(resourcePath("player", value, "ownership")),
  );
  add(
    server,
    "yahoo_player_percent_owned",
    "Get a player's ownership percentage.",
    player,
    ({ playerKey: value }) =>
      api.get(resourcePath("player", value, "percent_owned")),
  );
  add(
    server,
    "yahoo_player_draft_analysis",
    "Get a player's average draft position and related analysis.",
    player,
    ({ playerKey: value }) =>
      api.get(resourcePath("player", value, "draft_analysis")),
  );

  const transaction = z.object({ transactionKey }).strict();
  add(
    server,
    "yahoo_transaction",
    "Get transaction metadata and default player data.",
    transaction,
    ({ transactionKey: value }) => api.get(resourcePath("transaction", value)),
  );
  add(
    server,
    "yahoo_transaction_players",
    "Get players involved in a transaction.",
    transaction,
    ({ transactionKey: value }) =>
      api.get(resourcePath("transaction", value, "players")),
  );
}

function registerWriteTools(server: McpServer, api: YahooApi): void {
  const lineupPlayer = z.object({ playerKey, position: nonEmpty }).strict();
  const lineup = z
    .object({
      teamKey,
      coverage: z.discriminatedUnion("type", [
        z.object({
          type: z.literal("week"),
          value: z.number().int().positive(),
        }),
        z.object({ type: z.literal("date"), value: date }),
      ]),
      players: z.array(lineupPlayer).min(1).max(100),
    })
    .strict();
  add(
    server,
    "yahoo_set_lineup",
    "Immediately change selected player positions in a real Yahoo lineup.",
    lineup,
    (args) =>
      api.put(
        resourcePath("team", args.teamKey, "roster"),
        buildRosterPayload(args.coverage, args.players),
      ),
    true,
  );

  const addPlayer = z
    .object({
      leagueKey,
      teamKey,
      playerKey,
      faabBid: z.number().int().nonnegative().optional(),
    })
    .strict();
  add(
    server,
    "yahoo_add_player",
    "Add a free agent or submit a waiver claim for a player.",
    addPlayer,
    (args) =>
      api.post(
        resourcePath("league", args.leagueKey, "transactions"),
        buildTransactionPayload({
          type: "add",
          faabBid: args.faabBid,
          players: [
            {
              playerKey: args.playerKey,
              transactionType: "add",
              destinationTeamKey: args.teamKey,
            },
          ],
        }),
      ),
    true,
  );

  const dropPlayer = z.object({ leagueKey, teamKey, playerKey }).strict();
  add(
    server,
    "yahoo_drop_player",
    "Immediately drop a player from a real Yahoo team.",
    dropPlayer,
    (args) =>
      api.post(
        resourcePath("league", args.leagueKey, "transactions"),
        buildTransactionPayload({
          type: "drop",
          players: [
            {
              playerKey: args.playerKey,
              transactionType: "drop",
              sourceTeamKey: args.teamKey,
            },
          ],
        }),
      ),
    true,
  );

  const addDrop = z
    .object({
      leagueKey,
      teamKey,
      addPlayerKey: playerKey,
      dropPlayerKey: playerKey,
      faabBid: z.number().int().nonnegative().optional(),
    })
    .strict();
  add(
    server,
    "yahoo_add_drop_player",
    "Replace one rostered player with a free agent or waiver player.",
    addDrop,
    (args) =>
      api.post(
        resourcePath("league", args.leagueKey, "transactions"),
        buildTransactionPayload({
          type: "add/drop",
          faabBid: args.faabBid,
          players: [
            {
              playerKey: args.addPlayerKey,
              transactionType: "add",
              destinationTeamKey: args.teamKey,
            },
            {
              playerKey: args.dropPlayerKey,
              transactionType: "drop",
              sourceTeamKey: args.teamKey,
            },
          ],
        }),
      ),
    true,
  );

  const tradePlayer = z
    .object({ playerKey, sourceTeamKey: teamKey, destinationTeamKey: teamKey })
    .strict();
  const proposeTrade = z
    .object({
      leagueKey,
      traderTeamKey: teamKey,
      tradeeTeamKey: teamKey,
      tradeNote: z.string().max(2000).optional(),
      players: z.array(tradePlayer).min(1).max(100),
    })
    .strict();
  add(
    server,
    "yahoo_propose_trade",
    "Propose a real trade between Yahoo teams.",
    proposeTrade,
    (args) =>
      api.post(
        resourcePath("league", args.leagueKey, "transactions"),
        buildTradePayload(args),
      ),
    true,
  );

  const editWaiver = z
    .object({
      transactionKey,
      waiverPriority: z.number().int().nonnegative().optional(),
      faabBid: z.number().int().nonnegative().optional(),
    })
    .strict();
  add(
    server,
    "yahoo_edit_waiver",
    "Edit the priority or FAAB bid of a pending waiver claim.",
    editWaiver,
    (args) =>
      api.put(
        resourcePath("transaction", args.transactionKey),
        buildWaiverEditPayload(args),
      ),
    true,
  );

  const tradeAction = z
    .object({
      transactionKey,
      action: z.enum(["accept", "reject", "allow", "disallow", "vote_against"]),
      tradeNote: z.string().max(2000).optional(),
      voterTeamKey: teamKey.optional(),
    })
    .strict();
  add(
    server,
    "yahoo_trade_action",
    "Accept, reject, allow, disallow, or vote against a pending trade.",
    tradeAction,
    (args) =>
      api.put(
        resourcePath("transaction", args.transactionKey),
        buildTransactionActionPayload(args),
      ),
    true,
  );

  const cancel = z.object({ transactionKey }).strict();
  add(
    server,
    "yahoo_cancel_transaction",
    "Cancel a pending waiver claim or unaccepted trade proposal.",
    cancel,
    ({ transactionKey: value }) =>
      api.delete(resourcePath("transaction", value)),
    true,
  );
}

function registerAdvancedGet(server: McpServer, api: YahooApi): void {
  const schema = z
    .object({
      path: nonEmpty.describe("Relative path under /fantasy/v2"),
      query: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional(),
    })
    .strict();
  add(
    server,
    "yahoo_advanced_get",
    "Perform a constrained GET against a documented Yahoo Fantasy path.",
    schema,
    ({ path, query }) =>
      api.get(appendQuery(safeAdvancedPath(path), query ?? {})),
  );
}

export function registerYahooTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  registerReadTools(server, runtime.yahoo);
  registerWriteTools(server, runtime.yahoo);
  registerAdvancedGet(server, runtime.yahoo);
}

export const toolNames = [
  "yahoo_user_games",
  "yahoo_user_leagues",
  "yahoo_user_teams",
  "yahoo_game",
  "yahoo_game_dates",
  "yahoo_game_weeks",
  "yahoo_game_stat_categories",
  "yahoo_game_position_types",
  "yahoo_game_roster_positions",
  "yahoo_game_leagues",
  "yahoo_game_players",
  "yahoo_league",
  "yahoo_league_settings",
  "yahoo_league_standings",
  "yahoo_league_scoreboard",
  "yahoo_league_teams",
  "yahoo_league_players",
  "yahoo_league_draft_results",
  "yahoo_league_transactions",
  "yahoo_team",
  "yahoo_team_stats",
  "yahoo_team_standings",
  "yahoo_team_roster",
  "yahoo_team_draft_results",
  "yahoo_team_matchups",
  "yahoo_player",
  "yahoo_player_stats",
  "yahoo_player_ownership",
  "yahoo_player_percent_owned",
  "yahoo_player_draft_analysis",
  "yahoo_transaction",
  "yahoo_transaction_players",
  "yahoo_set_lineup",
  "yahoo_add_player",
  "yahoo_drop_player",
  "yahoo_add_drop_player",
  "yahoo_propose_trade",
  "yahoo_edit_waiver",
  "yahoo_trade_action",
  "yahoo_cancel_transaction",
  "yahoo_advanced_get",
] as const;
