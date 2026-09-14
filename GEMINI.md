# Project guide

This repository contains a portable Yahoo Fantasy Football agent plugin and a Model Context Protocol v2 server for the Yahoo
Fantasy Sports API. It supports local stdio and Streamable HTTP with optional
SSE response streaming. It is implemented in strict TypeScript on Node.js
20.19 or newer and uses the MCP TypeScript SDK v2.

## Development

Install dependencies and run the complete release gate:

```sh
npm ci
npm run verify
npm pack --dry-run
```

`npm run verify` checks types, lint, formatting, tests, and the production
build. Keep all source in `src/`, tests in `tests/`, and generated output in
`dist/`.

## Architecture

- `src/config.ts` validates Yahoo and Streamable HTTP configuration.
- `src/http.ts` owns the official v2 web handler, Node adapter, endpoint
  routing, Host/Origin checks, bearer protection, and graceful shutdown.
- `src/yahoo/` owns OAuth, secure token persistence, HTTP behavior, XML
  parsing, and documented write payloads.
- `src/mcp/` owns tool schemas, Yahoo resource paths, annotations, and MCP
  result/error translation.
- `src/cli.ts` provides auth, status, logout, doctor, smoke, stdio serving, and
  explicit `serve --transport http` commands.

Do not log or commit Yahoo credentials or tokens. Writes must not be retried
automatically. Keep the advanced API tool GET-only and constrained to relative
Yahoo Fantasy API paths. Any new mutation must match Yahoo's documented XML
contract and include focused tests.

The npm release workflow uses trusted publishing through GitHub Actions OIDC.
Never add a long-lived npm token to the workflow.

## Agent plugin

The plugin always runs the published `@kwonye/yahoo-fantasy-mcp` package using npx.
Never add a source-build or local-source runtime fallback. `src/agent/` supplies
profile, run, preflight, journal, and reconciliation capabilities in that npm
package. Keep direct MCP interfaces compatible. The skill uses journaled actions.
Validate with `npm run plugin:validate` and `npm run plugin:pack`; synchronize
release versions with `npm run release:version -- <version>`. Publish npm and
verify both installed launch paths before distributing the plugin.
