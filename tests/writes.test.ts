import { describe, expect, it } from "vitest";
import {
  buildRosterPayload,
  buildTradePayload,
  buildTransactionActionPayload,
  buildTransactionPayload,
  buildWaiverEditPayload,
} from "../src/yahoo/writes.js";

describe("Yahoo write payloads", () => {
  it("builds the documented NFL lineup payload", () => {
    const xml = buildRosterPayload({ type: "week", value: 13 }, [
      { playerKey: "461.p.8332", position: "WR" },
      { playerKey: "461.p.1423", position: "BN" },
    ]);
    expect(xml).toContain(
      "<fantasy_content><roster><coverage_type>week</coverage_type><week>13</week>",
    );
    expect(xml).toContain(
      "<player_key>461.p.8332</player_key><position>WR</position>",
    );
    expect(xml).not.toContain("selected_position");
  });

  it("builds dated non-NFL lineups", () => {
    const xml = buildRosterPayload({ type: "date", value: "2026-08-21" }, [
      { playerKey: "500.p.1", position: "UTIL" },
    ]);
    expect(xml).toContain(
      "<coverage_type>date</coverage_type><date>2026-08-21</date>",
    );
    expect(() =>
      buildRosterPayload({ type: "date", value: "08/21/2026" }, [
        { playerKey: "x", position: "BN" },
      ]),
    ).toThrow("YYYY-MM-DD");
  });

  it("nests add/drop transaction data exactly once", () => {
    const xml = buildTransactionPayload({
      type: "add/drop",
      faabBid: 12,
      players: [
        {
          playerKey: "461.p.1",
          transactionType: "add",
          destinationTeamKey: "461.l.1.t.1",
        },
        {
          playerKey: "461.p.2",
          transactionType: "drop",
          sourceTeamKey: "461.l.1.t.1",
        },
      ],
    });
    expect(xml).toContain(
      "<type>add/drop</type><faab_bid>12</faab_bid><players>",
    );
    expect(xml).toContain(
      "<transaction_data><type>add</type><destination_team_key>461.l.1.t.1</destination_team_key></transaction_data>",
    );
    expect(xml).toContain(
      "<transaction_data><type>drop</type><source_team_key>461.l.1.t.1</source_team_key></transaction_data>",
    );
  });

  it("uses Yahoo's singular player element for a standalone add", () => {
    const xml = buildTransactionPayload({
      type: "add",
      players: [
        {
          playerKey: "461.p.1",
          transactionType: "add",
          destinationTeamKey: "461.l.1.t.1",
        },
      ],
    });

    expect(xml).toContain("<transaction><type>add</type><player>");
    expect(xml).not.toContain("<players>");
  });

  it("builds trade, waiver edit, and trade action payloads", () => {
    const trade = buildTradePayload({
      traderTeamKey: "461.l.1.t.1",
      tradeeTeamKey: "461.l.1.t.2",
      tradeNote: "Fair trade",
      players: [
        {
          playerKey: "461.p.1",
          sourceTeamKey: "461.l.1.t.1",
          destinationTeamKey: "461.l.1.t.2",
        },
      ],
    });
    expect(trade).toContain("<trade_note>Fair trade</trade_note>");
    expect(trade).toContain("<transaction_data><type>pending_trade</type>");

    expect(
      buildWaiverEditPayload({ transactionKey: "461.l.1.w.c.2", faabBid: 20 }),
    ).toContain(
      "<transaction_key>461.l.1.w.c.2</transaction_key><type>waiver</type><faab_bid>20</faab_bid>",
    );
    expect(
      buildTransactionActionPayload({
        transactionKey: "461.l.1.pt.1",
        action: "vote_against",
        voterTeamKey: "461.l.1.t.2",
      }),
    ).toContain(
      "<action>vote_against</action><voter_team_key>461.l.1.t.2</voter_team_key>",
    );
  });

  it("escapes caller-controlled XML", () => {
    const xml = buildTransactionActionPayload({
      transactionKey: "461.l.1.pt.1",
      action: "reject",
      tradeNote: "No <script> & no deal",
    });
    expect(xml).toContain("No &lt;script&gt; &amp; no deal");
  });
});
