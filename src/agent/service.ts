import { randomUUID } from "node:crypto";
import type { YahooApi } from "../mcp/types.js";
import { errorPayload } from "../mcp/helpers.js";
import { writeOperations } from "../mcp/write-operations.js";
import { YahooError } from "../yahoo/errors.js";
import {
  actionPlayerKeys,
  identify,
  named,
  object,
  rosterPlayers,
  scalar,
  selectedPosition,
  snapshot,
  teamTransactions,
  validateAction,
  values,
} from "./context.js";
import {
  actionSchema,
  teamKeySchema,
  profileSchema,
  type AgentAction,
  type AgentRun,
  type Evidence,
  type JournalAction,
  type Scope,
  type TeamProfile,
  type TeamState,
} from "./schema.js";
import { type AgentStore, agentError, fingerprint } from "./store.js";

const RUN_DURATION = 30 * 60_000;
const PREFLIGHT_DURATION = 5 * 60_000;
const uncertain = (action: JournalAction): boolean =>
  action.status === "submitted" || action.status === "uncertain";

export class AgentService {
  public constructor(
    private readonly api: YahooApi,
    public readonly store: AgentStore,
    private readonly now: () => number = Date.now,
  ) {}
  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }
  private async scoped<T>(
    teamKey: string,
    fn: (state: TeamState, save: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const scope = await identify(this.api, teamKeySchema.parse(teamKey));
    return this.store.withTeam(scope, fn);
  }
  private profile(state: TeamState): TeamProfile {
    if (!state.profile || state.profile.authority !== "full")
      throw agentError(
        "AGENT_NOT_ENROLLED",
        "Team is not enrolled for active management",
        "Obtain the user's team-management authorization and save a full profile, or resume the paused profile at their request",
      );
    return profileSchema.parse(state.profile);
  }
  private run(state: TeamState, id: string): AgentRun {
    const run = state.runs.find((r) => r.id === id);
    if (
      !run ||
      run.status !== "running" ||
      Date.parse(run.expiresAt) <= this.now()
    )
      throw agentError(
        "AGENT_RUN_EXPIRED",
        "Run is missing, finished, or expired",
        "Start a new run and reconcile any uncertain actions first",
      );
    return run;
  }
  private parseAction(value: AgentAction): AgentAction {
    const action = actionSchema.parse(value);
    const operation = writeOperations(this.api).get(action.tool)!;
    return {
      tool: action.tool,
      arguments: object(operation.schema.parse(action.arguments)),
    };
  }
  public getProfile(teamKey: string): Promise<unknown> {
    return this.scoped(teamKey, (state) =>
      Promise.resolve({
        scope: state.scope,
        profile: state.profile,
        dataDirectory: this.store.directory,
      }),
    );
  }
  public saveProfile(
    teamKey: string,
    season: string,
    profile: TeamProfile,
  ): Promise<unknown> {
    return this.scoped(teamKey, async (state, save) => {
      if (state.scope.season !== season)
        throw agentError(
          "AGENT_SCOPE_MISMATCH",
          "Profile season does not match the selected team's Yahoo season",
        );
      state.profile = profileSchema.parse(profile);
      state.preflights = [];
      await save();
      return { scope: state.scope, profile: state.profile };
    });
  }
  public startRun(teamKey: string): Promise<unknown> {
    return this.scoped(teamKey, async (state, save) => {
      this.profile(state);
      for (const run of state.runs.filter((r) => r.status === "running")) {
        if (Date.parse(run.expiresAt) > this.now())
          throw agentError(
            "AGENT_RUN_BUSY",
            "A management run is already active",
            "Use the existing run ID from this host's saved context or wait for its 30-minute lease to expire",
          );
        run.status = "interrupted";
      }
      const run: AgentRun = {
        id: randomUUID(),
        startedAt: this.timestamp(),
        expiresAt: new Date(this.now() + RUN_DURATION).toISOString(),
        status: "running",
      };
      state.runs.push(run);
      state.preflights = [];
      await save();
      return {
        scope: state.scope,
        profile: state.profile,
        run,
        unresolvedActions: state.actions.filter(uncertain),
      };
    });
  }
  public finishRun(
    teamKey: string,
    runId: string,
    summary: string,
    nextCheckAt?: string,
  ): Promise<unknown> {
    return this.scoped(teamKey, async (state, save) => {
      const run = this.run(state, runId);
      run.status = state.actions.some(uncertain)
        ? "needs_attention"
        : "completed";
      run.summary = summary;
      if (nextCheckAt !== undefined) run.nextCheckAt = nextCheckAt;
      await save();
      return {
        run,
        schedule: state.profile?.schedule,
        schedulingNote:
          "nextCheckAt is advisory; only the host can schedule another run",
      };
    });
  }
  public history(
    teamKey: string,
    limit: number,
    before?: string,
  ): Promise<unknown> {
    return this.scoped(teamKey, (state) => {
      const actions = state.actions
        .filter((a) => before === undefined || a.submittedAt < before)
        .slice(-limit)
        .reverse();
      return Promise.resolve({
        scope: state.scope,
        runs: state.runs.slice(-limit).reverse(),
        actions,
        nextBefore: actions.at(-1)?.submittedAt,
        unresolvedActions: state.actions.filter(uncertain),
      });
    });
  }
  public prepare(
    teamKey: string,
    runId: string,
    input: AgentAction,
  ): Promise<unknown> {
    const action = this.parseAction(input);
    return this.scoped(teamKey, async (state, save) => {
      const profile = this.profile(state);
      this.run(state, runId);
      if (state.actions.some(uncertain))
        throw agentError(
          "AGENT_UNCERTAIN_WRITE",
          "An earlier action needs reconciliation",
          "Call yahoo_agent_reconcile for each unresolved action; do not use direct write tools to bypass the journal",
        );
      const context = await snapshot(this.api, state.scope, action);
      validateAction(state.scope, profile, action, context, this.now());
      if (
        [
          "yahoo_add_player",
          "yahoo_add_drop_player",
          "yahoo_propose_trade",
        ].includes(action.tool) &&
        context.transactions.some(
          (t) =>
            ["pending", "proposed"].includes(String(t.status)) &&
            this.matchesIntent(state.scope, action, t),
        )
      )
        throw agentError(
          "AGENT_DUPLICATE_PENDING",
          "A matching pending claim or trade already exists",
          "Inspect the existing transaction and edit it if necessary instead of submitting a duplicate",
        );
      const preflight = {
        id: randomUUID(),
        runId,
        action,
        snapshot: context,
        createdAt: this.timestamp(),
        fingerprint: fingerprint(context),
      };
      state.preflights = [
        ...state.preflights.filter(
          (p) => this.now() - Date.parse(p.createdAt) < PREFLIGHT_DURATION,
        ),
        preflight,
      ].slice(-20);
      await save();
      return {
        preflight,
        expiresAt: new Date(this.now() + PREFLIGHT_DURATION).toISOString(),
        scope: state.scope,
      };
    });
  }
  public execute(
    teamKey: string,
    runId: string,
    preflightId: string,
    decisionId: string,
    rationale: string,
    evidence: Evidence[],
  ): Promise<unknown> {
    return this.scoped(teamKey, async (state, save) => {
      const existing = state.actions.find((a) => a.id === decisionId);
      if (existing) {
        if (existing.preflight.id !== preflightId)
          throw agentError(
            "AGENT_DECISION_CONFLICT",
            "Decision ID was already used with another preflight",
          );
        return { action: existing, replayed: true }; // Never re-send even when the first response was lost.
      }
      const profile = this.profile(state);
      this.run(state, runId);
      if (state.actions.some(uncertain))
        throw agentError(
          "AGENT_UNCERTAIN_WRITE",
          "Reconcile the earlier uncertain write first",
        );
      const preflight = state.preflights.find(
        (p) => p.id === preflightId && p.runId === runId,
      );
      if (
        !preflight ||
        this.now() - Date.parse(preflight.createdAt) >= PREFLIGHT_DURATION
      )
        throw agentError(
          "AGENT_PREFLIGHT_EXPIRED",
          "Preflight is missing or older than five minutes",
          "Refresh research as necessary and prepare the action again",
        );
      const action = this.parseAction(preflight.action);
      const context = await snapshot(this.api, state.scope, action);
      validateAction(state.scope, profile, action, context, this.now());
      if (fingerprint(context) !== preflight.fingerprint)
        throw agentError(
          "AGENT_STALE_CONTEXT",
          "Yahoo state changed after preparation",
          "Reevaluate with fresh Yahoo context and create a new preflight",
        );
      if (evidence.some((e) => Date.parse(e.observedAt) > this.now() + 60_000))
        throw agentError(
          "AGENT_INVALID_EVIDENCE",
          "Evidence timestamps cannot be in the future",
        );
      const entry: JournalAction = {
        id: decisionId,
        runId,
        preflight,
        rationale,
        evidence,
        status: "submitted",
        submittedAt: this.timestamp(),
        updatedAt: this.timestamp(),
        transactionKeys: [],
      };
      state.actions.push(entry);
      state.preflights = state.preflights.filter((p) => p.id !== preflightId);
      await save(); // Durable intent BEFORE the single Yahoo request.
      try {
        entry.result = await writeOperations(this.api)
          .get(action.tool)!
          .execute(action.arguments);
        entry.transactionKeys = named(entry.result, "transaction")
          .map((t) => scalar(t.transaction_key))
          .filter((key): key is string => key !== undefined);
      } catch (error) {
        entry.error = {
          ...errorPayload(error),
          retryable: false,
          action:
            "Reconcile this journal entry; never automatically repeat this Yahoo write",
        };
        entry.status =
          error instanceof YahooError &&
          [400, 401, 403, 404, 409, 422, 429].includes(error.status ?? 0)
            ? "rejected"
            : "uncertain";
      }
      entry.updatedAt = this.timestamp();
      await save();
      if (entry.status === "submitted") {
        await this.verify(state.scope, entry);
        await save();
      }
      return { action: entry };
    });
  }
  public reconcile(teamKey: string, decisionId: string): Promise<unknown> {
    return this.scoped(teamKey, async (state, save) => {
      const entry = state.actions.find((a) => a.id === decisionId);
      if (!entry)
        throw agentError(
          "AGENT_ACTION_NOT_FOUND",
          "No journal entry with that decision ID exists for this account and team",
        );
      if (uncertain(entry)) {
        await this.verify(state.scope, entry);
        await save();
      }
      return { action: entry };
    });
  }
  private async verify(scope: Scope, entry: JournalAction): Promise<void> {
    const { tool, arguments: args } = entry.preflight.action;
    try {
      let verified = false;
      if (tool === "yahoo_set_lineup") {
        const coverage = object(args.coverage);
        const period =
          coverage.type === "week"
            ? `;week=${String(coverage.value)}`
            : `;date=${String(coverage.value)}`;
        const response = await this.api.get(
          `team/${scope.teamKey}/roster${period}`,
        );
        entry.reconciliation = response.data;
        const roster = named(response.data, "player");
        verified = values(args.players).every((v) => {
          const p = object(v);
          return roster.some(
            (live) =>
              live.player_key === p.playerKey &&
              selectedPosition(live) === p.position,
          );
        });
      } else if (typeof args.transactionKey === "string") {
        try {
          const response = await this.api.get(
            `transaction/${args.transactionKey}`,
          );
          entry.reconciliation = response.data;
          const transaction = named(response.data, "transaction").find(
            (t) => t.transaction_key === args.transactionKey,
          );
          if (transaction) {
            if (tool === "yahoo_cancel_transaction")
              verified = ["cancelled", "canceled"].includes(
                String(transaction.status),
              );
            if (tool === "yahoo_trade_action")
              verified = (
                args.action === "accept"
                  ? ["accepted", "successful", "completed"]
                  : ["rejected"]
              ).includes(String(transaction.status));
            if (tool === "yahoo_edit_waiver")
              verified =
                (args.faabBid === undefined ||
                  scalar(transaction.faab_bid) === scalar(args.faabBid)) &&
                (args.waiverPriority === undefined ||
                  scalar(transaction.waiver_priority) ===
                    scalar(args.waiverPriority));
          }
        } catch (error) {
          if (
            tool === "yahoo_cancel_transaction" &&
            error instanceof YahooError &&
            error.status === 404
          ) {
            verified = true;
            entry.reconciliation = {
              transactionKey: args.transactionKey,
              absent: true,
            };
          } else throw error;
        }
      } else {
        let transactions: Record<string, unknown>[];
        if (entry.transactionKeys.length) {
          transactions = [];
          for (const key of entry.transactionKeys) {
            if (
              !key.startsWith(`${scope.leagueKey}.`) ||
              !/^[a-zA-Z0-9.]+$/.test(key)
            )
              throw agentError(
                "AGENT_SCOPE_MISMATCH",
                "Yahoo write returned a transaction outside the enrolled league",
              );
            transactions.push(
              ...named(
                (await this.api.get(`transaction/${key}`)).data,
                "transaction",
              ),
            );
          }
        } else {
          transactions = await teamTransactions(this.api, scope);
        }
        const previousKeys = new Set(
          entry.preflight.snapshot.transactions.map((t) => t.transaction_key),
        );
        const matches = transactions.filter(
          (t) =>
            !previousKeys.has(t.transaction_key) &&
            this.matchesTransaction(scope, entry, t),
        );
        entry.reconciliation = {
          candidates: transactions,
          matchedKeys: matches.map((t) => t.transaction_key),
        };
        if (matches.length === 1) {
          verified = true;
          entry.transactionKeys = [String(matches[0]!.transaction_key)];
        }
        // A drop/add can be verified from roster state ONLY with a successful Yahoo receipt.
        if (
          !verified &&
          entry.result &&
          [
            "yahoo_add_player",
            "yahoo_drop_player",
            "yahoo_add_drop_player",
          ].includes(tool)
        ) {
          const response = await this.api.get(`team/${scope.teamKey}/roster`);
          const roster = named(response.data, "player");
          const before = rosterPlayers(entry.preflight.snapshot);
          const added =
            args.addPlayerKey ??
            (tool === "yahoo_add_player" ? args.playerKey : undefined);
          const dropped =
            args.dropPlayerKey ??
            (tool === "yahoo_drop_player" ? args.playerKey : undefined);
          verified =
            (added === undefined ||
              (!before.some((p) => p.player_key === added) &&
                roster.some((p) => p.player_key === added))) &&
            (dropped === undefined ||
              (before.some((p) => p.player_key === dropped) &&
                !roster.some((p) => p.player_key === dropped)));
          entry.reconciliation = {
            ...object(entry.reconciliation),
            roster: response.data,
          };
        }
      }
      entry.status = verified ? "verified" : "uncertain";
    } catch (error) {
      entry.status = "uncertain";
      entry.reconciliation = { error: errorPayload(error) };
    }
    entry.updatedAt = this.timestamp();
  }
  private matchesTransaction(
    scope: Scope,
    entry: JournalAction,
    transaction: Record<string, unknown>,
  ): boolean {
    const knownKey = entry.transactionKeys.includes(
      String(transaction.transaction_key),
    );
    const timestamp = Number(transaction.timestamp) * 1000;
    if (
      !knownKey &&
      (!Number.isFinite(timestamp) ||
        timestamp < Date.parse(entry.submittedAt) - 1000)
    )
      return false;
    return this.matchesIntent(scope, entry.preflight.action, transaction);
  }
  private matchesIntent(
    scope: Scope,
    action: AgentAction,
    transaction: Record<string, unknown>,
  ): boolean {
    const { tool, arguments: args } = action;
    const expectedType =
      tool === "yahoo_propose_trade"
        ? "pending_trade"
        : tool === "yahoo_drop_player"
          ? "drop"
          : tool === "yahoo_add_drop_player"
            ? "add/drop"
            : "add";
    if (
      transaction.type !== expectedType &&
      !(
        transaction.type === "waiver" &&
        ["add", "add/drop"].includes(expectedType)
      )
    )
      return false;
    if (
      !["pending", "proposed", "successful", "accepted", "completed"].includes(
        String(transaction.status),
      )
    )
      return false;
    const players = named(transaction, "player");
    if (
      fingerprint(players.map((p) => String(p.player_key)).sort()) !==
      fingerprint(actionPlayerKeys(action))
    )
      return false;
    if (
      args.faabBid !== undefined &&
      scalar(transaction.faab_bid) !== scalar(args.faabBid)
    )
      return false;
    if (tool === "yahoo_propose_trade")
      return (
        transaction.trader_team_key === scope.teamKey &&
        transaction.tradee_team_key === args.tradeeTeamKey &&
        values(args.players).every((v) => {
          const p = object(v);
          const match = players.find((live) => live.player_key === p.playerKey);
          return values(match?.transaction_data).some(
            (d) =>
              object(d).source_team_key === p.sourceTeamKey &&
              object(d).destination_team_key === p.destinationTeamKey,
          );
        })
      );
    return players.every((p) =>
      values(p.transaction_data).some((d) => {
        const data = object(d);
        const drop =
          p.player_key ===
          (args.dropPlayerKey ??
            (tool === "yahoo_drop_player" ? args.playerKey : undefined));
        return drop
          ? data.source_team_key === scope.teamKey
          : data.destination_team_key === scope.teamKey;
      }),
    );
  }
}
