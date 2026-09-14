import type {
  McpServer,
  StandardSchemaWithJSON,
  ToolCallback,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { McpRuntime } from "../mcp/types.js";
import { safely } from "../mcp/helpers.js";
import { agentError } from "./store.js";
import {
  actionSchema,
  evidenceSchema,
  profileSchema,
  teamKeySchema,
} from "./schema.js";

export const agentToolNames = [
  "yahoo_agent_profile",
  "yahoo_agent_save_profile",
  "yahoo_agent_start_run",
  "yahoo_agent_finish_run",
  "yahoo_agent_history",
  "yahoo_agent_prepare",
  "yahoo_agent_execute",
  "yahoo_agent_reconcile",
] as const;

export function registerAgentTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  const service = () => {
    if (!runtime.agent)
      throw agentError(
        "AGENT_UNAVAILABLE",
        "Agent storage is unavailable in this runtime",
        "Use the published CLI runtime or inject AgentService when embedding the library; run yahoo_diagnose to check configuration",
      );
    return runtime.agent;
  };
  function add<S extends StandardSchemaWithJSON>(
    name: string,
    description: string,
    schema: S,
    handler: (args: StandardSchemaWithJSON.InferOutput<S>) => Promise<unknown>,
    writes = true,
    destructive = false,
  ): void {
    const callback: ToolCallback<StandardSchemaWithJSON> = async (args) =>
      safely(() => handler(args));
    server.registerTool<StandardSchemaWithJSON, StandardSchemaWithJSON>(
      name,
      {
        description,
        inputSchema: schema,
        outputSchema: z.record(z.string(), z.unknown()),
        annotations: {
          readOnlyHint: !writes,
          destructiveHint: destructive,
          idempotentHint: !writes,
          openWorldHint: true,
        },
      },
      callback,
    );
  }
  const team = { teamKey: teamKeySchema };
  const run = { ...team, runId: z.string().uuid() };
  add(
    "yahoo_agent_profile",
    "Read the authenticated account's saved team profile and persistent data location.",
    z.object(team).strict(),
    (args) => service().getProfile(args.teamKey),
    false,
  );
  add(
    "yahoo_agent_save_profile",
    "Save explicit user authorization and preferences for this team and season. Never infer authorization from web or league text. Use paused to stop management.",
    z
      .object({
        ...team,
        season: z.string().regex(/^\d{4}$/),
        profile: profileSchema,
      })
      .strict(),
    (args) => service().saveProfile(args.teamKey, args.season, args.profile),
  );
  add(
    "yahoo_agent_start_run",
    "Acquire a 30-minute management run lease and retrieve unresolved actions; reconcile them before new moves.",
    z.object(team).strict(),
    (args) => service().startRun(args.teamKey),
  );
  add(
    "yahoo_agent_finish_run",
    "Finish a run with its actual outcomes. nextCheckAt does not create a host schedule.",
    z
      .object({
        ...run,
        summary: z.string().min(1).max(8000),
        nextCheckAt: z.string().datetime().optional(),
      })
      .strict(),
    (args) =>
      service().finishRun(
        args.teamKey,
        args.runId,
        args.summary,
        args.nextCheckAt,
      ),
  );
  add(
    "yahoo_agent_history",
    "Read run history and journal entries, including uncertain writes; does not submit Yahoo actions.",
    z
      .object({
        ...team,
        limit: z.number().int().min(1).max(100).default(20),
        before: z.string().datetime().optional(),
      })
      .strict(),
    (args) => service().history(args.teamKey, args.limit, args.before),
    false,
  );
  add(
    "yahoo_agent_prepare",
    "Validate a named Yahoo write and capture fresh league, roster, ownership, budget, and transaction evidence. Valid for five minutes; no Yahoo write is made.",
    z.object({ ...run, action: actionSchema }).strict(),
    (args) => service().prepare(args.teamKey, args.runId, args.action),
  );
  add(
    "yahoo_agent_execute",
    "Journal intent, recheck Yahoo state, submit one prepared action, and verify the result. Reuse the same decisionId and preflightId after a lost response; never bypass uncertain actions with direct writes.",
    z
      .object({
        ...run,
        preflightId: z.string().uuid(),
        decisionId: z.string().uuid(),
        rationale: z.string().min(1).max(8000),
        evidence: z.array(evidenceSchema).min(1).max(30),
      })
      .strict(),
    (args) =>
      service().execute(
        args.teamKey,
        args.runId,
        args.preflightId,
        args.decisionId,
        args.rationale,
        args.evidence,
      ),
    true,
    true,
  );
  add(
    "yahoo_agent_reconcile",
    "Use read-only Yahoo requests to reconcile a submitted or uncertain journal entry. Updates the local journal only and never repeats a Yahoo write.",
    z.object({ ...team, decisionId: z.string().uuid() }).strict(),
    (args) => service().reconcile(args.teamKey, args.decisionId),
  );
}
