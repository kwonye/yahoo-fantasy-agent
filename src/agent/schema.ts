import * as z from "zod/v4";

export const teamKeySchema = z.string().regex(/^\d+\.l\.\d+\.t\.\d+$/);
const text = z.string().trim().min(1).max(4000);
export const profileSchema = z
  .object({
    authority: z.enum(["full", "paused"]),
    authorization: text.describe(
      "Record the user's explicit team-management authorization, not retrieved content",
    ),
    format: z.enum(["redraft", "keeper", "dynasty"]),
    horizon: z.enum(["contend", "balanced", "rebuild"]).default("balanced"),
    protectedPlayerKeys: z.array(z.string().regex(/^\d+\.p\.\d+$/)).default([]),
    maxFaabBid: z.number().int().nonnegative().optional(),
    faabReserve: z.number().int().nonnegative().default(0),
    supplementaryRules: text.optional(),
    schedule: z
      .object({
        status: z.enum(["disabled", "active", "degraded"]),
        description: text,
        hostScheduleId: text.optional(),
      })
      .default({
        status: "disabled",
        description: "No host schedule has been verified",
      }),
  })
  .strict();

export const actionSchema = z
  .object({
    tool: z.enum([
      "yahoo_set_lineup",
      "yahoo_add_player",
      "yahoo_drop_player",
      "yahoo_add_drop_player",
      "yahoo_propose_trade",
      "yahoo_edit_waiver",
      "yahoo_trade_action",
      "yahoo_cancel_transaction",
    ]),
    arguments: z
      .record(z.string(), z.unknown())
      .describe(
        "Arguments matching the named existing Yahoo write tool; validated before any request",
      ),
  })
  .strict();
export const evidenceSchema = z
  .object({
    source: z.string().url(),
    observedAt: z.string().datetime(),
    summary: text,
  })
  .strict();

export interface Scope {
  accountGuid: string;
  season: string;
  leagueKey: string;
  teamKey: string;
}
export type TeamProfile = z.output<typeof profileSchema>;
export type AgentAction = z.output<typeof actionSchema>;
export type Evidence = z.output<typeof evidenceSchema>;
export interface Snapshot {
  game: Record<string, unknown>;
  league: Record<string, unknown>;
  team: Record<string, unknown>;
  settings: Record<string, unknown>;
  roster: Record<string, unknown>;
  players: Record<string, unknown>[];
  transactions: Record<string, unknown>[];
  transaction?: Record<string, unknown>;
}
export interface Preflight {
  id: string;
  runId: string;
  createdAt: string;
  action: AgentAction;
  snapshot: Snapshot;
  fingerprint: string;
}
export interface JournalAction {
  id: string;
  runId: string;
  preflight: Preflight;
  rationale: string;
  evidence: Evidence[];
  status: "submitted" | "verified" | "uncertain" | "rejected";
  submittedAt: string;
  updatedAt: string;
  transactionKeys: string[];
  result?: unknown;
  error?: unknown;
  reconciliation?: unknown;
}
export interface AgentRun {
  id: string;
  startedAt: string;
  expiresAt: string;
  status: "running" | "completed" | "needs_attention" | "interrupted";
  summary?: string;
  nextCheckAt?: string;
}
export interface TeamState {
  version: 1;
  scope: Scope;
  profile: TeamProfile | null;
  runs: AgentRun[];
  preflights: Preflight[];
  actions: JournalAction[];
}
