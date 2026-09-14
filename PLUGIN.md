# Yahoo Fantasy Football Agent

A portable agent plugin for league-specific football research and autonomous Yahoo team management. Your host supplies the model, web research, schedules, and notifications. The plugin connects to the published `@kwonye/yahoo-fantasy-mcp@1.1.0` package through `npx`; it contains no MCP source, build step, or independent agent daemon.

## Install

Install the `yahoo-fantasy-agent` release archive from [GitHub Releases](https://github.com/kwonye/yahoo-fantasy-agent/releases) in an Agent Plugins v1 host, or use its Codex compatibility manifest with a local Codex marketplace. Node.js 20.19+ and npm/npx must be available. The first launch needs access to npm. Existing local source and dependencies are never a fallback.

The portable `mcp.json` uses persistent host `PLUGIN_DATA`. The native `.mcp.json` uses the normal per-user configuration directory. `YAHOO_FANTASY_DATA_DIR` overrides both. Run `yahoo_diagnose` to see the directory actually used, then use that same directory for authentication. Configuring multiple hosts against one team requires them to share the same persistent directory and account to coordinate locks/journals; separate installations do not coordinate automatically. Use a local filesystem for this state.

For standalone MCP clients, a global-install alternative is:

```sh
npm install -g @kwonye/yahoo-fantasy-mcp@1.1.0
yahoo-fantasy-mcp auth
yahoo-fantasy-mcp
```

Configure that client's command as `yahoo-fantasy-mcp`; both alternatives execute the published npm package. Existing stdio, Streamable HTTP, library consumers, and non-football Yahoo tools remain supported.

## Connect Yahoo

Create an approved Yahoo application with private Fantasy Sports Read/Write access. Store `YAHOO_CLIENT_ID`, `YAHOO_CLIENT_SECRET`, and `YAHOO_REDIRECT_URI=oob` in the diagnosed data directory's `.env`, with owner-only permissions, or in the host's secret environment. Never put credentials into plugin manifests. Use the matching directory for the interactive flow:

```sh
YAHOO_FANTASY_DATA_DIR="/absolute/path/from-diagnosis" \
  npx --yes @kwonye/yahoo-fantasy-mcp@1.1.0 auth
```

Then diagnose again and ask the host to “Manage my Yahoo fantasy football team.” Select the team and grant full management authority when enrolling. The agent discovers scoring and roster rules and saves your horizon, protected players, and spending preferences. New seasons require enrollment. Ask to pause management to stop new actions.

## What autonomous management means

The skill researches current evidence, evaluates your actual league, and uses journaled MCP operations to set lineups, manage IR, acquire/drop players, manage claims/FAAB, and propose/respond to trades. Format support includes redraft, keeper/dynasty, PPR, superflex, and IDP. Draft advice and unsupported Yahoo operations remain advisory. Commissioner intervention and unrelated messaging are excluded.

Unattended operation requires a host schedule and compatible host execution permissions. Setup verifies the actual schedule: hourly in season, more frequent checks near relevant deadlines where supported, and daily offseason checks. The plugin does not schedule itself, bypass host approvals, or continue while its host is unavailable. Reports stay in the host and focus on meaningful changes or failures.

Writes are sent once. A pending claim or trade is reported as pending, even when its submission is verified. Lost responses are reconciled through the journal rather than blindly retried. If Yahoo cannot establish an outcome, the affected team stops new writes and reports the unresolved action. Do not delete its journal to force a retry; inspect the Yahoo transaction and preserve the evidence.

Fantasy data provided by [Yahoo Fantasy](https://sports.yahoo.com/fantasy/). This independent project is not affiliated with Yahoo. [Source and MCP documentation](https://github.com/kwonye/yahoo-fantasy-agent) · [License](LICENSE).
