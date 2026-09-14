import * as z from "zod/v4";
import {
  buildRosterPayload,
  buildTradePayload,
  buildTransactionActionPayload,
  buildTransactionPayload,
  buildWaiverEditPayload,
} from "../yahoo/writes.js";
import { resourcePath } from "./helpers.js";
import type { YahooApi } from "./types.js";
const nonEmpty = z.string().trim().min(1);
const teamKey = nonEmpty;
const leagueKey = nonEmpty;
const playerKey = nonEmpty;
const transactionKey = nonEmpty;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export interface WriteOperation {
  description: string;
  schema: z.ZodType;
  execute: (args: unknown) => Promise<unknown>;
}

/** Shared schemas and payload handlers for direct MCP and journaled writes. */
export function writeOperations(api: YahooApi): Map<string, WriteOperation> {
  const operations = new Map<string, WriteOperation>();
  function add<S extends z.ZodType>(
    name: string,
    description: string,
    schema: S,
    handler: (args: z.output<S>) => Promise<unknown>,
  ): void {
    operations.set(name, {
      description,
      schema,
      execute: (args) => handler(schema.parse(args)),
    });
  }
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
    "yahoo_set_lineup",
    "Immediately change selected player positions in a real Yahoo lineup.",
    lineup,
    (args) =>
      api.put(
        resourcePath("team", args.teamKey, "roster"),
        buildRosterPayload(args.coverage, args.players),
      ),
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
  );

  const dropPlayer = z.object({ leagueKey, teamKey, playerKey }).strict();
  add(
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
    "yahoo_propose_trade",
    "Propose a real trade between Yahoo teams.",
    proposeTrade,
    (args) =>
      api.post(
        resourcePath("league", args.leagueKey, "transactions"),
        buildTradePayload(args),
      ),
  );

  const editWaiver = z
    .object({
      transactionKey,
      waiverPriority: z.number().int().nonnegative().optional(),
      faabBid: z.number().int().nonnegative().optional(),
    })
    .strict();
  add(
    "yahoo_edit_waiver",
    "Edit the priority or FAAB bid of a pending waiver claim.",
    editWaiver,
    (args) =>
      api.put(
        resourcePath("transaction", args.transactionKey),
        buildWaiverEditPayload(args),
      ),
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
    "yahoo_trade_action",
    "Accept, reject, allow, disallow, or vote against a pending trade.",
    tradeAction,
    (args) =>
      api.put(
        resourcePath("transaction", args.transactionKey),
        buildTransactionActionPayload(args),
      ),
  );

  const cancel = z.object({ transactionKey }).strict();
  add(
    "yahoo_cancel_transaction",
    "Cancel a pending waiver claim or unaccepted trade proposal.",
    cancel,
    ({ transactionKey: value }) =>
      api.delete(resourcePath("transaction", value)),
  );
  return operations;
}
