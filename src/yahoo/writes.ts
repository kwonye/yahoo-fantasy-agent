import { renderYahooXml, xmlNode, type XmlNode } from "./xml.js";

export type RosterCoverage =
  | { readonly type: "week"; readonly value: number }
  | { readonly type: "date"; readonly value: string };

export interface RosterPlayer {
  readonly playerKey: string;
  readonly position: string;
}

function requiredString(value: string, name: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${name} must not be empty`);
  return value.trim();
}

function playersXml(players: readonly RosterPlayer[]): XmlNode {
  if (players.length === 0) throw new Error("At least one player is required");
  return xmlNode(
    "players",
    players.map((player) =>
      xmlNode("player", [
        xmlNode("player_key", requiredString(player.playerKey, "playerKey")),
        xmlNode("position", requiredString(player.position, "position")),
      ]),
    ),
  );
}

/** Build the PUT body for weekly or date-based roster updates. */
export function buildRosterPayload(
  coverage: RosterCoverage,
  players: readonly RosterPlayer[],
): string {
  if (
    coverage.type === "week" &&
    (!Number.isSafeInteger(coverage.value) || coverage.value < 1)
  ) {
    throw new Error("Roster week must be a positive integer");
  }
  if (coverage.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(coverage.value)) {
    throw new Error("Roster date must use YYYY-MM-DD format");
  }
  return renderYahooXml(
    xmlNode(
      "fantasy_content",
      xmlNode("roster", [
        xmlNode("coverage_type", coverage.type),
        xmlNode(coverage.type, coverage.value),
        playersXml(players),
      ]),
    ),
  );
}

export type TransactionType =
  "add" | "drop" | "add/drop" | "waiver" | "pending_trade" | (string & {});
export type TransactionDataType = "add" | "drop";

export interface TransactionPlayer {
  readonly playerKey: string;
  readonly transactionType: TransactionDataType;
  readonly sourceTeamKey?: string | undefined;
  readonly destinationTeamKey?: string | undefined;
  readonly faabBid?: number | undefined;
  readonly waiverPriority?: number | undefined;
}

export interface TransactionPayload {
  readonly type: TransactionType;
  readonly players: readonly TransactionPlayer[];
  readonly destinationTeamKey?: string | undefined;
  readonly sourceTeamKey?: string | undefined;
  readonly waiverPriority?: number | undefined;
  readonly faabBid?: number | undefined;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function transactionDataXml(player: TransactionPlayer): XmlNode {
  const data: XmlNode[] = [xmlNode("type", player.transactionType)];
  if (player.sourceTeamKey !== undefined)
    data.push(
      xmlNode(
        "source_team_key",
        requiredString(player.sourceTeamKey, "sourceTeamKey"),
      ),
    );
  if (player.destinationTeamKey !== undefined)
    data.push(
      xmlNode(
        "destination_team_key",
        requiredString(player.destinationTeamKey, "destinationTeamKey"),
      ),
    );
  if (player.faabBid !== undefined)
    data.push(
      xmlNode("faab_bid", nonNegativeInteger(player.faabBid, "faabBid")),
    );
  if (player.waiverPriority !== undefined)
    data.push(
      xmlNode(
        "waiver_priority",
        nonNegativeInteger(player.waiverPriority, "waiverPriority"),
      ),
    );
  return xmlNode("transaction_data", data);
}

/** Build the POST body for adds, drops, waiver claims, and trades. */
export function buildTransactionPayload(payload: TransactionPayload): string {
  if (typeof payload.type !== "string" || payload.type.trim() === "")
    throw new Error("Transaction type must not be empty");
  if (payload.players.length === 0)
    throw new Error("At least one transaction player is required");
  const transaction: XmlNode[] = [xmlNode("type", payload.type.trim())];
  if (payload.destinationTeamKey !== undefined)
    transaction.push(
      xmlNode(
        "destination_team_key",
        requiredString(payload.destinationTeamKey, "destinationTeamKey"),
      ),
    );
  if (payload.sourceTeamKey !== undefined)
    transaction.push(
      xmlNode(
        "source_team_key",
        requiredString(payload.sourceTeamKey, "sourceTeamKey"),
      ),
    );
  if (payload.waiverPriority !== undefined)
    transaction.push(
      xmlNode(
        "waiver_priority",
        nonNegativeInteger(payload.waiverPriority, "waiverPriority"),
      ),
    );
  if (payload.faabBid !== undefined)
    transaction.push(
      xmlNode("faab_bid", nonNegativeInteger(payload.faabBid, "faabBid")),
    );
  const playerNodes = payload.players.map((player) =>
    xmlNode("player", [
      xmlNode("player_key", requiredString(player.playerKey, "playerKey")),
      transactionDataXml(player),
    ]),
  );
  // Yahoo's add and drop examples use a singular <player>; the combined
  // add/drop form uses the <players> collection wrapper.
  if (
    (payload.type === "add" || payload.type === "drop") &&
    playerNodes.length === 1 &&
    playerNodes[0] !== undefined
  ) {
    transaction.push(playerNodes[0]);
  } else {
    transaction.push(xmlNode("players", playerNodes));
  }
  return renderYahooXml(
    xmlNode("fantasy_content", xmlNode("transaction", transaction)),
  );
}

export interface TradePlayer {
  readonly playerKey: string;
  readonly sourceTeamKey: string;
  readonly destinationTeamKey: string;
}

export interface TradePayload {
  readonly traderTeamKey: string;
  readonly tradeeTeamKey: string;
  readonly players: readonly TradePlayer[];
  readonly tradeNote?: string | undefined;
}

/** Build Yahoo's documented POST body for proposing a trade. */
export function buildTradePayload(payload: TradePayload): string {
  if (payload.players.length === 0)
    throw new Error("At least one traded player is required");
  const transaction: XmlNode[] = [
    xmlNode("type", "pending_trade"),
    xmlNode(
      "trader_team_key",
      requiredString(payload.traderTeamKey, "traderTeamKey"),
    ),
    xmlNode(
      "tradee_team_key",
      requiredString(payload.tradeeTeamKey, "tradeeTeamKey"),
    ),
  ];
  if (payload.tradeNote !== undefined)
    transaction.push(xmlNode("trade_note", payload.tradeNote));
  transaction.push(
    xmlNode(
      "players",
      payload.players.map((player) =>
        xmlNode("player", [
          xmlNode("player_key", requiredString(player.playerKey, "playerKey")),
          xmlNode("transaction_data", [
            xmlNode("type", "pending_trade"),
            xmlNode(
              "source_team_key",
              requiredString(player.sourceTeamKey, "sourceTeamKey"),
            ),
            xmlNode(
              "destination_team_key",
              requiredString(player.destinationTeamKey, "destinationTeamKey"),
            ),
          ]),
        ]),
      ),
    ),
  );
  return renderYahooXml(
    xmlNode("fantasy_content", xmlNode("transaction", transaction)),
  );
}

export type TradeAction =
  "accept" | "reject" | "allow" | "disallow" | "vote_against";

export interface TransactionActionPayload {
  readonly transactionKey: string;
  readonly type?: "pending_trade" | "waiver" | undefined;
  readonly action: TradeAction;
  readonly tradeNote?: string | undefined;
  readonly voterTeamKey?: string | undefined;
}

/** Build the PUT body for pending-trade actions documented by Yahoo. */
export function buildTransactionActionPayload(
  payload: TransactionActionPayload,
): string {
  const nodes: XmlNode[] = [
    xmlNode(
      "transaction_key",
      requiredString(payload.transactionKey, "transactionKey"),
    ),
    xmlNode("type", payload.type ?? "pending_trade"),
    xmlNode("action", payload.action),
  ];
  if (payload.tradeNote !== undefined)
    nodes.push(xmlNode("trade_note", payload.tradeNote));
  if (payload.voterTeamKey !== undefined)
    nodes.push(
      xmlNode(
        "voter_team_key",
        requiredString(payload.voterTeamKey, "voterTeamKey"),
      ),
    );
  return renderYahooXml(
    xmlNode("fantasy_content", xmlNode("transaction", nodes)),
  );
}

export interface WaiverEditPayload {
  readonly transactionKey: string;
  readonly waiverPriority?: number | undefined;
  readonly faabBid?: number | undefined;
}

/** Build the PUT body for editing a pending waiver priority or FAAB bid. */
export function buildWaiverEditPayload(payload: WaiverEditPayload): string {
  const nodes: XmlNode[] = [
    xmlNode(
      "transaction_key",
      requiredString(payload.transactionKey, "transactionKey"),
    ),
    xmlNode("type", "waiver"),
  ];
  if (payload.waiverPriority !== undefined)
    nodes.push(
      xmlNode(
        "waiver_priority",
        nonNegativeInteger(payload.waiverPriority, "waiverPriority"),
      ),
    );
  if (payload.faabBid !== undefined)
    nodes.push(
      xmlNode("faab_bid", nonNegativeInteger(payload.faabBid, "faabBid")),
    );
  if (nodes.length <= 2)
    throw new Error("waiverPriority or faabBid is required");
  return renderYahooXml(
    xmlNode("fantasy_content", xmlNode("transaction", nodes)),
  );
}
