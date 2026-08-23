# Yahoo Fantasy Sports MCP

An MCP server for Yahoo Fantasy Sports. It supports Yahoo Fantasy Football,
Baseball, Basketball, and Hockey through local stdio or MCP v2 Streamable HTTP,
with OAuth 2.0 authentication and typed read and write tools.

[![CI](https://github.com/kwonye/yahoo-fantasy-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/kwonye/yahoo-fantasy-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@kwonye/yahoo-fantasy-mcp)](https://www.npmjs.com/package/@kwonye/yahoo-fantasy-mcp)

## Install and run

Node.js 20.19 or newer is required. Install the published package globally:

```sh
npm install -g @kwonye/yahoo-fantasy-mcp
```

The `yahoo-fantasy-mcp` executable speaks MCP over stdio by default. Run the
authentication flow once, then add the executable to your MCP client:

```sh
yahoo-fantasy-mcp auth
yahoo-fantasy-mcp status
yahoo-fantasy-mcp
```

For an HTTP deployment, start the MCP v2 Streamable HTTP endpoint explicitly:

```sh
yahoo-fantasy-mcp serve --transport http
```

The default listener is `http://127.0.0.1:3000/mcp`. Override the host, port,
path, or response shape with flags or the corresponding `MCP_HTTP_*` variables:

```sh
yahoo-fantasy-mcp serve --transport http \
  --host 127.0.0.1 --port 3000 --path /mcp --response-mode auto
```

`auto` returns normal JSON for request/response calls and upgrades to an SSE
stream when the protocol needs server-to-client streaming. Use `sse` to always
stream or `json` to disable streaming for ordinary exchanges. This is the
current Streamable HTTP transport; the deprecated `/sse` plus `/messages`
server transport is not exposed.

For a checkout or a release candidate, use `npm install` followed by
`npm run build`, or run the TypeScript CLI with `npm run dev`.

## Yahoo application setup

The Yahoo Fantasy Sports API requires an approved Yahoo Developer Network
application. Create an **Installed Application** using Yahoo's [New API Key
flow](https://developer.yahoo.com/apps/), request private Fantasy Sports data,
and choose **Read/Write** access if you intend to use the mutation tools. A
read-only application can use every read tool but Yahoo will reject writes.

For this local CLI, use Yahoo's documented out-of-band callback (`oob`). The
callback value must be the same in the authorization and token requests.

1. Copy `.env.example` to `.env`.
2. Set `YAHOO_CLIENT_ID`, `YAHOO_CLIENT_SECRET`, and, unless you need another
   registered callback, `YAHOO_REDIRECT_URI=oob`.
3. Protect the file (`chmod 600 .env`) and start the flow:

   ```sh
   cp .env.example .env
   $EDITOR .env
   yahoo-fantasy-mcp auth
   ```

4. Open the URL printed by `auth` in a browser, grant access, and paste the
   authorization code back into the CLI when prompted.

Yahoo's [Fantasy Sports API guide](https://developer.yahoo.com/fantasysports/guide/)
and [OAuth authorization-code guide](https://developer.yahoo.com/oauth2/guide/flows_authcode/)
are the source of truth for application approval, callback values, scopes, and
token lifetime. Yahoo issues short-lived access tokens and refresh tokens; the
server refreshes access tokens as needed and rotates the stored refresh token
when Yahoo returns a replacement.

Useful local commands:

```sh
yahoo-fantasy-mcp status   # show configuration and token state, never secrets
yahoo-fantasy-mcp doctor   # check prerequisites and API reachability
yahoo-fantasy-mcp smoke    # authenticated, read-only Yahoo request checks
yahoo-fantasy-mcp logout   # remove the local authorization cache
```

## MCP client configuration

Add a server entry to the client that supports MCP stdio servers. Keep the
credentials in the client environment or in a local, untracked `.env`; do not
commit them to a client configuration file.

```json
{
  "mcpServers": {
    "yahoo-fantasy": {
      "command": "yahoo-fantasy-mcp",
      "env": {
        "YAHOO_CLIENT_ID": "your-client-id",
        "YAHOO_CLIENT_SECRET": "your-client-secret",
        "YAHOO_REDIRECT_URI": "oob"
      }
    }
  }
}
```

If the executable is not on the client's `PATH`, use its absolute path. An
alternative for clients that support `npx` is:

```json
{
  "mcpServers": {
    "yahoo-fantasy": {
      "command": "npx",
      "args": ["--yes", "@kwonye/yahoo-fantasy-mcp"],
      "env": {
        "YAHOO_CLIENT_ID": "your-client-id",
        "YAHOO_CLIENT_SECRET": "your-client-secret",
        "YAHOO_REDIRECT_URI": "oob"
      }
    }
  }
}
```

The server writes protocol messages only to stdout. Diagnostics go to stderr,
so MCP clients can launch it without a logging or JSON framing conflict.

For an HTTP-capable MCP client, configure the endpoint URL instead of a local
command. For example:

```json
{
  "mcpServers": {
    "yahoo-fantasy": {
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

## Available tools

Tool names are stable and grouped by the Yahoo resource they operate on. Every
read tool accepts the key or context it needs and returns structured data while
preserving Yahoo's resource keys, collection metadata, and sport-specific
periods.

### Read tools

| Group       | Capabilities                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User        | List the authenticated user's games, leagues, and owned teams                                                                                                             |
| Game        | Game metadata, supported dates, weeks, stat categories, position types, roster positions, leagues, and players                                                            |
| League      | League metadata and settings, standings, scoreboard, teams, player search, draft results, and transactions                                                                |
| Team        | Team metadata, stats, standings, roster, draft results, and matchups                                                                                                      |
| Player      | Player metadata, stats, ownership, percentage owned, and draft analysis                                                                                                   |
| Transaction | Transaction metadata and its players                                                                                                                                      |
| Advanced    | A GET-only `/fantasy/v2` request for documented resources that do not have a dedicated helper; host, authorization headers, and non-GET methods are not caller-controlled |

The registered read tool names are:

- User: `yahoo_user_games`, `yahoo_user_leagues`, `yahoo_user_teams`.
- Game: `yahoo_game`, `yahoo_game_dates`, `yahoo_game_weeks`,
  `yahoo_game_stat_categories`, `yahoo_game_position_types`,
  `yahoo_game_roster_positions`, `yahoo_game_leagues`, `yahoo_game_players`.
- League: `yahoo_league`, `yahoo_league_settings`, `yahoo_league_standings`,
  `yahoo_league_scoreboard`, `yahoo_league_teams`, `yahoo_league_players`,
  `yahoo_league_draft_results`, `yahoo_league_transactions`.
- Team: `yahoo_team`, `yahoo_team_stats`, `yahoo_team_standings`,
  `yahoo_team_roster`, `yahoo_team_draft_results`, `yahoo_team_matchups`.
- Player: `yahoo_player`, `yahoo_player_stats`, `yahoo_player_ownership`,
  `yahoo_player_percent_owned`, `yahoo_player_draft_analysis`.
- Transaction: `yahoo_transaction`, `yahoo_transaction_players`.
- Advanced: `yahoo_advanced_get`.

### Write tools

The write tools map to Yahoo's documented PUT, POST, and DELETE operations:

- Set a weekly or date-based lineup.
- Add a player, drop a player, or submit an add/drop transaction, including
  waiver and FAAB parameters.
- Propose a trade and accept, reject, allow, disallow, or vote against a trade.
- Edit waiver priority or a FAAB bid.
- Cancel a pending waiver claim or trade.

The registered write tool names are `yahoo_set_lineup`, `yahoo_add_player`,
`yahoo_drop_player`, `yahoo_add_drop_player`, `yahoo_propose_trade`,
`yahoo_edit_waiver`, `yahoo_trade_action`, and `yahoo_cancel_transaction`.

Writes are sent only once and are never automatically retried. Review the
league, team, player, and transaction keys before invoking a mutation. Yahoo
does not provide a general-purpose Fantasy Sports sandbox, so use a test league
if you need to exercise a write.

## Security and privacy

- Never commit `.env`, Yahoo client secrets, authorization codes, access tokens,
  or refresh tokens. The server stores tokens in the per-user configuration
  directory with owner-only permissions; `YAHOO_TOKEN_PATH` can override that
  location when needed.
- The original demo contained an exposed Yahoo client secret. If that version
  has ever been pushed, revoke and replace the secret in Yahoo Developer
  Network; deleting it from a working tree does not remove it from Git history.
- `logout` removes the local token cache. Also revoke this application's access
  from Yahoo account settings when a machine is lost or no longer trusted.
- Error messages redact authorization headers, client secrets, tokens, and
  OAuth response bodies that could contain credentials.
- HTTP binds to loopback by default and validates Host and Origin headers to
  prevent DNS rebinding. A non-loopback bind requires `MCP_HTTP_TOKEN` and an
  explicit `MCP_HTTP_ALLOWED_HOSTS` list; put TLS and any broader access policy
  in front of the process with a trusted reverse proxy.
- The MCP bearer token is a deployment credential only. Yahoo OAuth tokens
  remain local to the server and are never accepted from MCP callers.
- Treat lineup, roster, waiver, FAAB, trade, and commissioner tools as
  consequential actions. The MCP annotations identify read-only versus
  destructive operations so compatible clients can apply their own approval
  policy.

See [Yahoo's OAuth troubleshooting guide](https://developer.yahoo.com/oauth2/guide/troubleshooting/)
for invalid-grant, callback, and application-type errors.

## Development and releases

```sh
npm ci
npm run verify
npm pack --dry-run
```

`npm run verify` runs typechecking, linting, formatting checks, tests, and the
production build. GitHub Actions runs this verification and the package dry run
on Node.js 20, 22, and 24 for pushes and pull requests.

Publishing is performed by `.github/workflows/publish.yml` after a GitHub
Release is published. The release tag is authoritative: publishing `v1.2.3`
automatically sets both package manifests to `1.2.3` inside the release job,
then verifies and publishes that exact version. A manual package-version edit
is not required. This workflow accepts stable `v<major>.<minor>.<patch>` tags;
it rejects prereleases so they cannot accidentally become npm's `latest`
version. The public scoped package receives automatic provenance from this
public GitHub repository.

Because npm requires a package to exist before a trusted publisher can be
configured, bootstrap the currently unpublished package once from a protected
developer machine:

```sh
npm ci
npm run verify
npm pack --dry-run
npm login                 # use an npm account with 2FA enabled
npm publish --access public # publishes the initial 1.0.0 package
```

Do not put an npm token in the repository or in GitHub Actions. After the
bootstrap publish, configure npm Trusted Publishing for
`@kwonye/yahoo-fantasy-mcp`:

1. On npm, open the package's **Trusted Publishers** settings and add **GitHub
   Actions**.
2. Set the owner to `kwonye`, repository to
   `yahoo-fantasy-mcp`, workflow filename to `publish.yml`, and select
   the `npm publish` action. If you use a GitHub deployment environment, enter
   its exact name too.
3. Ensure `package.json`'s `repository.url` remains the exact GitHub repository
   URL and publish a release with the desired `v<version>` tag.

The bootstrap package already occupies version `1.0.0`, so the first GitHub
Release handled by this workflow must use the next package version (for
example, create the `v1.0.1` release). The workflow applies that version
automatically and avoids asking npm to publish the same immutable version
twice.

The workflow uses GitHub's OIDC identity (`id-token: write`) and npm's current
trusted-publishing protocol; no long-lived `NPM_TOKEN` secret is required.
npm's [trusted publishers documentation](https://docs.npmjs.com/trusted-publishers/)
requires npm CLI 11.5.1 or newer and Node.js 22.14.0 or newer for the publish
job. Once the scoped package has been bootstrapped publicly, trusted publishes
from this public repository receive npm's automatic provenance attestation.

## Attribution and license

Yahoo Fantasy Sports and Yahoo are trademarks of Yahoo Inc. This project is an
independent community integration and is not endorsed by or affiliated with
Yahoo Inc. API access remains subject to Yahoo's [developer terms](https://developer.yahoo.com/terms/)
and Fantasy Sports API approval. When displaying API-derived data, preserve
Yahoo's required attribution: [Fantasy data provided by Yahoo Fantasy](https://sports.yahoo.com/fantasy/).
This server is a data transport and does not render a UI; MCP clients should
keep that attribution with any Yahoo Fantasy data they display.

This project is distributed under the ISC license; see [LICENSE](LICENSE).
