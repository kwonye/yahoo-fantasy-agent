# Onboarding and scheduling

## Runtime and authentication

Use the installed connection. Its package is `@kwonye/yahoo-fantasy-mcp@1.1.0`; the CLI alternative is `npm install -g @kwonye/yahoo-fantasy-mcp@1.1.0` followed by `yahoo-fantasy-mcp`. Never substitute a local source build.

`yahoo_diagnose` reports `dataDirectory` and token state. Portable hosts use their persistent `PLUGIN_DATA`; native Codex and standalone CLI default to `~/.config/yahoo-fantasy-mcp` (or XDG configuration home). `YAHOO_FANTASY_DATA_DIR` explicitly overrides the directory. Use the same directory for configuration, auth, and subsequent runs.

The user supplies Yahoo app credentials in that directory's owner-readable `.env` or through the host's secret environment. Keep credentials out of manifests, conversation, evidence, and journals. For authentication, use `YAHOO_FANTASY_DATA_DIR="<diagnosed-directory>" npx --yes @kwonye/yahoo-fantasy-mcp@1.1.0 auth`. This is an interactive user authorization flow. Run diagnosis again afterward. The application needs Fantasy Read/Write access for management.

## Enrollment

Discover owned NFL teams, current game, league settings, roster, and standings. If the user selected a team by name, resolve it to the actual key. When ambiguous, ask which team. Save exactly the selected team and season; authority never automatically transfers to a new season or another account.

Capture full management or paused authority; redraft/keeper/dynasty format; contend/balanced/rebuild horizon; protected players; optional maximum FAAB bid and reserve; and supplementary rules Yahoo does not expose. Infer scoring, roster positions, league size, and waiver settings from Yahoo. Default horizon to balanced, protected players to none, reserve to zero, and no additional bid cap when the user has not chosen restrictions. Full management includes trade proposals/acceptance and available FAAB within these preferences.

Explain that host execution permissions still apply. A plugin cannot bypass the host's approvals, gain background execution by itself, or guarantee runs while the host is unavailable.

## Host schedules

After the user requests ongoing management, use the host's native scheduling tools. Prefer an existing schedule for this team over creating duplicates. Persist its identifier and actual supported cadence in the profile only after the host confirms creation or update.

Default to hourly in-season checks, daily offseason checks, and 15-minute checks during the two hours preceding relevant kickoff or waiver deadlines. Derive these windows from current schedules, league rules, and timezone; do not assume all games occur Sunday or waivers always process Wednesday. Rescheduled games, international kickoffs, and DST matter. Merge overlapping checks and prevent concurrent management through the run lease.

If the host cannot support dynamic windows, configure the closest supported cadence with the user's preferences and record `degraded` with the actual limitation. If it has no scheduler, save `disabled` and report that management runs only when invoked. Never invent tool names or install an independent daemon. `nextCheckAt` in a completed run is advisory, not proof of scheduling.

A scheduled prompt must invoke this skill for the exact enrolled team, refresh current evidence, use journaled execution, stay quiet on routine no-change runs, and notify on meaningful outcomes or required action. Pausing a profile stops new writes; reconcile any in-flight outcome and disable its host schedule as requested.
