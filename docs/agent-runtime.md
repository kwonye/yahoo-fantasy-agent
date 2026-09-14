# Management runtime contract

The host reasons and researches; `AgentService` manages account-scoped persistence and execution. Embedders can inject it through `McpRuntime.agent`. The default published CLI creates it automatically. The original Yahoo tools remain available for existing clients, but the football skill uses the journaled path exclusively. Profiles enforce this path's team preferences, not a global restriction on standalone MCP consumers.

| Tool                       | Inputs and result                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `yahoo_agent_profile`      | `teamKey`; resolves authenticated Yahoo identity and returns saved profile, scope, and data location.                                          |
| `yahoo_agent_save_profile` | `teamKey`, actual `season`, typed `profile`; saves explicit authority and invalidates old preflights.                                          |
| `yahoo_agent_start_run`    | `teamKey`; returns a run ID, 30-minute lease, profile, and unresolved actions.                                                                 |
| `yahoo_agent_prepare`      | `teamKey`, `runId`, `action: {tool, arguments}`; validates the existing write schema and current Yahoo context, saves a five-minute preflight. |
| `yahoo_agent_execute`      | Team/run/preflight IDs, UUID `decisionId`, rationale, timestamped source evidence; saves intent, rechecks context, sends once, and verifies.   |
| `yahoo_agent_reconcile`    | `teamKey`, `decisionId`; reads Yahoo and updates local verification state without another Yahoo write.                                         |
| `yahoo_agent_finish_run`   | `teamKey`, `runId`, summary, optional ISO `nextCheckAt`; closes the run and reports unresolved actions. Does not schedule a task.              |
| `yahoo_agent_history`      | `teamKey`, optional `limit` (1–100) and `before` timestamp; returns journal entries, recent runs, and all unresolved actions.                  |

The exported `TeamProfile`, `AgentAction`, `Scope`, `Evidence`, `JournalAction`, and `AgentRun` types describe the library contract. Existing write-tool schemas validate the action's arguments before any preflight request; the journal never accepts arbitrary HTTP methods, hosts, or payloads.

## State and recovery

Identity is derived from Yahoo's authenticated user, owned NFL team, and league season, rather than a caller-supplied account ID. Each account/season/league/team has a separate SHA-256-named state file. Profiles are not copied between seasons. The directory contains private team data; files use owner-only permissions, durable temporary writes, and atomic renames. Back up the directory as private data; do not include it in Git or releases.

An interprocess heartbeat lock serializes operations for a team. A crashed process's filesystem lock expires after two minutes; host run leases expire after 30 minutes. Neither expiration clears a submitted/uncertain journal entry. Do not manually remove live lockfiles. Shared state should reside on a local filesystem, and all managing hosts must use the same directory if they are to coordinate.

Intent is persisted as `submitted` before the single Yahoo write. Explicit Yahoo rejection is `rejected`; uncertain transport/upstream outcomes remain `uncertain`. Readback proves `verified`. For a waiver or trade, verified means Yahoo's receipt/status is confirmed, not that the pending transaction has completed. Automatic Yahoo write retries remain disabled, including on rate limits.

Execute replay with the same decision/preflight IDs returns the saved entry. A new decision cannot execute while uncertainty remains. Reconciliation looks for the exact transaction ID or a unique matching new transaction after submission; absence from a recent transaction page is never proof that the request failed. Unresolved ambiguity remains blocked and requires inspection. Reconciliation can continue while the profile is paused.

Preflight checks known league, roster, ownership, slot, protected-player, budget, season, and transaction conflicts. Yahoo still performs final validation: its locks/deadlines may change between read and write, and some fields may be absent. The host must obtain current game deadlines and news independently. The service does not invent missing projections, implement an NFL forecast model, or guarantee lineup execution before kickoff.

`AGENT_*` errors include an actionable recovery instruction and never ask the caller to blindly retry a write. A missing/corrupt journal is not silently reset. Evidence stores source URLs, observation times, and decision summaries; do not include credentials or irrelevant personal information.
