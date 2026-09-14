import type { YahooApi } from "../mcp/types.js";
import type { AgentAction, Scope, Snapshot, TeamProfile } from "./schema.js";
import { agentError } from "./store.js";

type Obj = Record<string, unknown>;
export function object(value: unknown): Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Obj)
    : {};
}
export function values(value: unknown): unknown[] {
  return value === undefined || value === null
    ? []
    : Array.isArray(value)
      ? value
      : [value];
}
export function named(value: unknown, key: string): Obj[] {
  if (Array.isArray(value)) return value.flatMap((v) => named(v, key));
  return Object.entries(object(value)).flatMap(([k, v]) =>
    k === key ? values(v).map(object) : named(v, key),
  );
}
export function scalar(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
}
function one(value: unknown, key: string): Obj {
  const found = named(value, key)[0];
  if (!found)
    throw agentError(
      "AGENT_CONTEXT_MISSING",
      `Yahoo returned no ${key} resource`,
    );
  return found;
}
export async function identify(api: YahooApi, teamKey: string): Promise<Scope> {
  const response = await api.get(
    `users;use_login=1/games;game_keys=${teamKey.split(".")[0]!}/teams`,
  );
  const user = one(response.data, "user");
  const accountGuid = scalar(user.guid);
  const team = named(user, "team").find((t) => t.team_key === teamKey);
  if (!accountGuid || !team)
    throw agentError(
      "AGENT_TEAM_NOT_OWNED",
      "This NFL team is not owned by the authenticated Yahoo account",
    );
  const leagueKey = teamKey.split(".t.")[0]!;
  const league = one((await api.get(`league/${leagueKey}`)).data, "league");
  const season = scalar(league.season);
  if (!season)
    throw agentError(
      "AGENT_CONTEXT_MISSING",
      "Yahoo did not identify the league season",
    );
  return { accountGuid, season, leagueKey, teamKey };
}
export function actionPlayerKeys(action: AgentAction): string[] {
  const args = action.arguments;
  return [
    ...new Set(
      [
        args.playerKey,
        args.addPlayerKey,
        args.dropPlayerKey,
        ...values(args.players).map((p) => object(p).playerKey),
      ].filter((key): key is string => typeof key === "string"),
    ),
  ].sort();
}
export async function teamTransactions(
  api: YahooApi,
  scope: Scope,
): Promise<Obj[]> {
  const base = `league/${scope.leagueKey}/transactions`;
  const recent = named(
    (await api.get(`${base};team_key=${scope.teamKey};count=100`)).data,
    "transaction",
  );
  const pending: Obj[] = [];
  // Pending claims are not guaranteed to be included in Yahoo's default list.
  for (let start = 0; start < 1000; start += 100) {
    const page = named(
      (
        await api.get(
          `${base};types=waiver,pending_trade;team_key=${scope.teamKey};start=${start};count=100`,
        )
      ).data,
      "transaction",
    );
    pending.push(...page);
    if (page.length < 100)
      return [
        ...new Map(
          [...recent, ...pending].map((t) => [String(t.transaction_key), t]),
        ).values(),
      ].sort((a, b) =>
        String(a.transaction_key).localeCompare(String(b.transaction_key)),
      );
  }
  throw agentError(
    "AGENT_CONTEXT_MISSING",
    "Too many pending transactions to establish a complete management context",
  );
}
export async function snapshot(
  api: YahooApi,
  scope: Scope,
  action: AgentAction,
): Promise<Snapshot> {
  const period = object(action.arguments.coverage);
  const suffix =
    period.type === "week"
      ? `;week=${String(period.value)}`
      : period.type === "date"
        ? `;date=${String(period.value)}`
        : "";
  const requests = [
    "game/nfl",
    `league/${scope.leagueKey}`,
    `team/${scope.teamKey}`,
    `league/${scope.leagueKey}/settings`,
    `team/${scope.teamKey}/roster${suffix}`,
  ];
  const [game, league, team, settings, roster] = await Promise.all(
    requests.map(async (path) => (await api.get(path)).data),
  );
  let transaction: Obj | undefined;
  const key = action.arguments.transactionKey;
  if (typeof key === "string") {
    if (!key.startsWith(`${scope.leagueKey}.`) || !/^[a-zA-Z0-9.]+$/.test(key))
      throw agentError(
        "AGENT_SCOPE_MISMATCH",
        "Transaction belongs to another league",
      );
    transaction = one(
      (await api.get(`transaction/${key}`)).data,
      "transaction",
    );
  }
  const players: Obj[] = [];
  const affectedKeys = [
    ...new Set([
      ...actionPlayerKeys(action),
      ...named(transaction, "player").map((p) => String(p.player_key)),
    ]),
  ].sort();
  for (const key of affectedKeys) {
    if (
      !/^\d+\.p\.\d+$/.test(key) ||
      key.split(".")[0] !== scope.teamKey.split(".")[0]
    )
      throw agentError(
        "AGENT_SCOPE_MISMATCH",
        "Player key belongs to another game",
      );
    const base = `league/${scope.leagueKey}/players;player_keys=${key}`;
    const metadata = one((await api.get(base)).data, "player");
    const ownership = one((await api.get(`${base}/ownership`)).data, "player");
    players.push({ ...metadata, ...ownership });
  }
  const transactions = await teamTransactions(api, scope);
  const result: Snapshot = {
    game: one(game, "game"),
    league: one(league, "league"),
    team: one(team, "team"),
    settings: one(settings, "settings"),
    roster: one(roster, "roster"),
    players,
    transactions,
  };
  if (transaction) result.transaction = transaction;
  return result;
}

export function rosterPlayers(context: Snapshot): Obj[] {
  return named(context.roster, "player");
}
export function selectedPosition(player: Obj): string | undefined {
  return scalar(object(player.selected_position).position);
}
function number(value: unknown): number | undefined {
  const s = scalar(value);
  if (s === undefined || s.trim() === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}
function locked(value: Obj): boolean {
  return scalar(value.is_editable) === "0" || scalar(value.is_locked) === "1";
}
function positions(player: Obj): string[] {
  return values(object(player.eligible_positions).position)
    .map(scalar)
    .filter((p): p is string => p !== undefined);
}
function transactionTeams(transaction: Obj): string[] {
  const teams = [transaction.trader_team_key, transaction.tradee_team_key];
  for (const player of named(transaction, "player")) {
    for (const data of values(player.transaction_data))
      teams.push(
        object(data).source_team_key,
        object(data).destination_team_key,
      );
  }
  return teams.filter((v): v is string => typeof v === "string");
}

/** Preflight catches known conflicts; Yahoo remains authoritative at submission. */
export function validateAction(
  scope: Scope,
  profile: TeamProfile,
  action: AgentAction,
  context: Snapshot,
  now: number,
): void {
  const reject = (message: string): never => {
    throw agentError("AGENT_ACTION_INVALID", message);
  };
  if (profile.authority !== "full") reject("Team management is paused");
  if (
    scalar(context.game.season) !== scope.season ||
    scalar(context.game.game_key) !== scope.teamKey.split(".")[0] ||
    scalar(context.league.season) !== scope.season
  )
    reject(
      "This profile is not for the current NFL season; enroll the current-season team",
    );
  if (scalar(context.league.is_finished) === "1")
    reject("Yahoo marks this league as finished");
  if (
    context.team.team_key !== scope.teamKey ||
    context.league.league_key !== scope.leagueKey
  )
    reject("Yahoo returned mismatched league or team context");
  const args = action.arguments;
  if (
    (args.teamKey !== undefined && args.teamKey !== scope.teamKey) ||
    (args.leagueKey !== undefined && args.leagueKey !== scope.leagueKey)
  )
    reject("Action targets a different team or league");
  const roster = rosterPlayers(context);
  const findPlayer = (key: unknown): Obj => {
    const found = roster.find((p) => p.player_key === key);
    return found ?? reject("Outgoing player is not on this roster");
  };
  const checkDrop = (key: unknown): void => {
    const player = findPlayer(key);
    if (profile.protectedPlayerKeys.includes(String(key)))
      reject("Player is protected by the saved team profile");
    if (
      scalar(player.is_undroppable) === "1" ||
      locked(player) ||
      locked(context.roster)
    )
      reject("Outgoing player is undroppable or locked");
  };
  const bid = number(args.faabBid);
  if (bid !== undefined) {
    const balance = number(context.team.faab_balance);
    // Reserve pending bids. Claims sharing a drop player are mutually exclusive.
    const commitments = new Map<string, number>();
    for (const transaction of context.transactions) {
      if (
        transaction.transaction_key === args.transactionKey ||
        transaction.type !== "waiver" ||
        transaction.status !== "pending"
      )
        continue;
      const drops = named(transaction, "player")
        .filter((p) =>
          values(p.transaction_data).some(
            (d) => object(d).source_team_key === scope.teamKey,
          ),
        )
        .map((p) => String(p.player_key));
      const group =
        drops.length === 1 ? drops[0]! : String(transaction.transaction_key);
      const pendingBid = number(transaction.faab_bid);
      if (bid > 0 && pendingBid === undefined)
        reject(
          "Yahoo omitted a pending waiver bid; cannot calculate available FAAB",
        );
      commitments.set(
        group,
        Math.max(commitments.get(group) ?? 0, pendingBid ?? 0),
      );
    }
    const ownGroup =
      typeof args.dropPlayerKey === "string" ? args.dropPlayerKey : undefined;
    const reserved = [...commitments].reduce(
      (sum, [group, value]) =>
        sum + (group === ownGroup ? Math.max(0, value - bid) : value),
      0,
    );
    if (bid > 0 && balance === undefined)
      reject("Yahoo did not expose a FAAB balance; cannot validate this bid");
    if (
      bid > (profile.maxFaabBid ?? Infinity) ||
      (balance !== undefined &&
        bid > Math.max(0, balance - profile.faabReserve - reserved))
    )
      reject("Bid exceeds available FAAB or saved spending preferences");
  }
  if (action.tool === "yahoo_set_lineup") {
    if (locked(context.roster)) reject("The selected roster period is locked");
    const coverage = object(args.coverage);
    if (
      coverage.type === "week" &&
      number(coverage.value)! <
        (number(context.league.current_week) ?? Infinity)
    )
      reject("Cannot edit a past or unknown fantasy week");
    if (
      coverage.type === "date" &&
      Date.parse(`${String(coverage.value)}T23:59:59-12:00`) < now
    )
      reject("Cannot edit a past date");
    const selected = new Map(
      roster.map((p) => [String(p.player_key), selectedPosition(p)]),
    );
    const changed = new Set<string>();
    for (const entry of values(args.players)) {
      const player = object(entry);
      const key = String(player.playerKey);
      const position = String(player.position);
      if (changed.has(key)) reject("Duplicate lineup player");
      changed.add(key);
      const current = findPlayer(key);
      const metadata = context.players.find((p) => p.player_key === key);
      if (locked(current) && selectedPosition(current) !== position)
        reject("Player is locked");
      const eligible = positions(current).length
        ? positions(current)
        : positions(metadata ?? {});
      if (position !== "BN" && !eligible.includes(position))
        reject(`Player is not eligible for ${position}`);
      selected.set(key, position);
    }
    const limits = new Map(
      named(context.settings, "roster_position").map((p) => [
        String(p.position),
        number(p.count),
      ]),
    );
    if (limits.size === 0)
      reject("Yahoo did not expose roster position limits");
    const counts = new Map<string, number>();
    for (const position of selected.values()) {
      if (!position)
        reject("Yahoo omitted a rostered player's selected position");
      counts.set(position!, (counts.get(position!) ?? 0) + 1);
    }
    for (const [position, count] of counts)
      if (count > (limits.get(position) ?? -1))
        reject(`Lineup exceeds ${position} capacity`);
  }
  if (action.tool === "yahoo_drop_player") checkDrop(args.playerKey);
  if (action.tool === "yahoo_add_drop_player") {
    checkDrop(args.dropPlayerKey);
    if (args.dropPlayerKey === args.addPlayerKey)
      reject("Cannot add and drop the same player");
  }
  if (
    action.tool === "yahoo_add_player" ||
    action.tool === "yahoo_add_drop_player"
  ) {
    const key = args.addPlayerKey ?? args.playerKey;
    const player = context.players.find((p) => p.player_key === key);
    if (
      !player ||
      !["freeagents", "waivers"].includes(
        String(object(player.ownership).ownership_type),
      )
    )
      reject("Target is not a free agent or waiver player in this league");
    const capacity = named(context.settings, "roster_position")
      .filter(
        (p) => !["IR", "IR+", "IL", "IL+", "NA"].includes(String(p.position)),
      )
      .reduce((sum, p) => sum + (number(p.count) ?? 0), 0);
    const occupied = roster.filter(
      (p) =>
        !["IR", "IR+", "IL", "IL+", "NA"].includes(selectedPosition(p) ?? ""),
    ).length;
    const freesSpot =
      action.tool === "yahoo_add_drop_player" &&
      !["IR", "IR+", "IL", "IL+", "NA"].includes(
        selectedPosition(findPlayer(args.dropPlayerKey)) ?? "",
      );
    if (capacity === 0 || occupied + 1 - Number(freesSpot) > capacity)
      reject("No active roster capacity for this acquisition");
  }
  if (action.tool === "yahoo_propose_trade") {
    if (
      args.traderTeamKey !== scope.teamKey ||
      args.tradeeTeamKey === scope.teamKey ||
      !String(args.tradeeTeamKey).startsWith(`${scope.leagueKey}.t.`)
    )
      reject(
        "Trade must originate from this team to another team in this league",
      );
    const seen = new Set<string>();
    for (const entry of values(args.players)) {
      const p = object(entry);
      const key = String(p.playerKey);
      if (seen.has(key)) reject("Duplicate traded player");
      seen.add(key);
      if (
        ![scope.teamKey, args.tradeeTeamKey].includes(
          String(p.sourceTeamKey),
        ) ||
        ![scope.teamKey, args.tradeeTeamKey].includes(
          String(p.destinationTeamKey),
        ) ||
        p.sourceTeamKey === p.destinationTeamKey
      )
        reject("Trade player has invalid source or destination");
      if (p.sourceTeamKey === scope.teamKey) checkDrop(p.playerKey);
      const live = context.players.find(
        (player) => player.player_key === p.playerKey,
      );
      if (object(live?.ownership).owner_team_key !== p.sourceTeamKey)
        reject("Trade player ownership changed");
    }
  }
  if (["yahoo_propose_trade", "yahoo_trade_action"].includes(action.tool)) {
    const deadline = scalar(context.settings.trade_end_date);
    if (
      deadline &&
      /^\d{4}-\d{2}-\d{2}$/.test(deadline) &&
      Date.parse(`${deadline}T23:59:59-12:00`) < now
    )
      reject("The league trade deadline has passed");
  }
  if (args.transactionKey !== undefined) {
    const transaction =
      context.transaction ?? reject("Transaction context is missing");
    if (
      transaction.transaction_key !== args.transactionKey ||
      !transactionTeams(transaction).includes(scope.teamKey)
    )
      reject("Transaction does not involve this team");
    if (!["pending", "proposed"].includes(String(transaction.status)))
      reject("Transaction is no longer pending");
    if (action.tool === "yahoo_trade_action") {
      if (!["accept", "reject"].includes(String(args.action)))
        reject(
          "Commissioner and voting actions are outside team-management authority",
        );
      if (
        transaction.type !== "pending_trade" ||
        transaction.tradee_team_key !== scope.teamKey
      )
        reject("Only the receiving team can accept or reject this trade");
      if (args.action === "accept") {
        let outgoing = 0,
          incoming = 0;
        for (const player of named(transaction, "player")) {
          for (const value of values(player.transaction_data)) {
            const data = object(value);
            if (data.source_team_key === scope.teamKey) {
              checkDrop(player.player_key);
              if (
                !["IR", "IR+", "IL", "IL+", "NA"].includes(
                  selectedPosition(findPlayer(player.player_key)) ?? "",
                )
              )
                outgoing++;
            }
            if (data.destination_team_key === scope.teamKey) incoming++;
            const current = context.players.find(
              (p) => p.player_key === player.player_key,
            );
            if (
              object(current?.ownership).owner_team_key !== data.source_team_key
            )
              reject("Trade player ownership changed");
          }
        }
        const capacity = named(context.settings, "roster_position")
          .filter(
            (p) =>
              !["IR", "IR+", "IL", "IL+", "NA"].includes(String(p.position)),
          )
          .reduce((sum, p) => sum + (number(p.count) ?? 0), 0);
        const occupied = roster.filter(
          (p) =>
            !["IR", "IR+", "IL", "IL+", "NA"].includes(
              selectedPosition(p) ?? "",
            ),
        ).length;
        if (capacity === 0 || occupied + incoming - outgoing > capacity)
          reject("Trade acceptance exceeds active roster capacity");
      }
    }
    if (action.tool === "yahoo_edit_waiver" && transaction.type !== "waiver")
      reject("Only pending waiver claims can be edited");
    if (action.tool === "yahoo_cancel_transaction") {
      if (!["waiver", "pending_trade"].includes(String(transaction.type)))
        reject("Only pending claims or trade proposals can be cancelled");
      if (
        transaction.type === "pending_trade" &&
        transaction.trader_team_key !== scope.teamKey
      )
        reject("Only this team's outgoing trade proposals can be cancelled");
    }
  }
}
