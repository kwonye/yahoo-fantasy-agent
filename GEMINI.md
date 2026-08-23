# Project guide

This repository contains a Model Context Protocol v2 server for the Yahoo
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
