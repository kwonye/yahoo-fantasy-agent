#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import {
  loadDefaultRuntime,
  serveYahooFantasy,
  serveYahooFantasyHttp,
} from "./index.js";
import {
  loadHttpConfig,
  type HttpConfig,
  type HttpConfigOverrides,
} from "./config.js";
import type { YahooHttpServerHandle } from "./http.js";
import { errorPayload, safely, stringify } from "./mcp/helpers.js";
import type { McpRuntime } from "./mcp/types.js";

export interface CliDependencies {
  loadRuntime?: () => Promise<McpRuntime>;
  serve?: (runtime: McpRuntime) => { close(): Promise<void> };
  serveHttp?: (
    runtime: McpRuntime,
    config: HttpConfig,
  ) => Promise<YahooHttpServerHandle>;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

interface ServeArguments extends HttpConfigOverrides {
  transport: "stdio" | "http";
}

function optionValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`${option} requires a value`);
  return value;
}

function parseServeArguments(argv: readonly string[]): ServeArguments {
  const parsed: ServeArguments = { transport: "stdio" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--transport": {
        const value = optionValue(argv, index, argument);
        if (value !== "stdio" && value !== "http")
          throw new Error("--transport must be stdio or http");
        parsed.transport = value;
        index += 1;
        break;
      }
      case "--host":
        parsed.host = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--port": {
        const value = optionValue(argv, index, argument);
        const port = Number(value);
        if (!Number.isSafeInteger(port) || port < 0 || port > 65_535)
          throw new Error("--port must be an integer between 0 and 65535");
        parsed.port = port;
        index += 1;
        break;
      }
      case "--path":
        parsed.path = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--response-mode": {
        const value = optionValue(argv, index, argument);
        if (value !== "auto" && value !== "sse" && value !== "json")
          throw new Error("--response-mode must be auto, sse, or json");
        parsed.responseMode = value;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown serve option ${JSON.stringify(argument)}`);
    }
  }
  if (parsed.transport === "stdio") {
    const httpOption = [
      parsed.host,
      parsed.port,
      parsed.path,
      parsed.responseMode,
    ].some((value) => value !== undefined);
    if (httpOption)
      throw new Error("HTTP serve options require --transport http");
  }
  return parsed;
}

function print(stream: NodeJS.WritableStream, value: unknown): void {
  stream.write(`${typeof value === "string" ? value : stringify(value)}\n`);
}

async function auth(
  runtime: McpRuntime,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<void> {
  if (!runtime.auth?.authorize)
    throw new Error("Authentication is unavailable in this runtime");
  const authorization = await runtime.auth.authorize();
  if (typeof authorization === "string")
    print(
      output,
      `Open this Yahoo authorization URL in a browser:\n${authorization}`,
    );
  else print(output, authorization);
  const readline = createInterface({ input, output });
  try {
    const code = await readline.question(
      "Paste the authorization code (or press Enter to finish): ",
    );
    if (code.trim() && runtime.auth.authenticate) {
      await runtime.auth.authenticate(code.trim());
      print(output, { authenticated: true });
    } else if (code.trim()) {
      throw new Error(
        "This runtime did not provide an OAuth code exchange function",
      );
    }
  } finally {
    readline.close();
  }
}

async function commandStatus(
  runtime: McpRuntime,
  output: NodeJS.WritableStream,
): Promise<void> {
  if (!runtime.auth?.status)
    throw new Error("Authentication status is unavailable in this runtime");
  print(output, await runtime.auth.status());
}

async function commandLogout(
  runtime: McpRuntime,
  output: NodeJS.WritableStream,
): Promise<void> {
  if (!runtime.auth?.logout)
    throw new Error("Logout is unavailable in this runtime");
  await runtime.auth.logout();
  print(output, { authenticated: false });
}

async function commandDoctor(
  runtime: McpRuntime,
  output: NodeJS.WritableStream,
): Promise<void> {
  if (runtime.doctor) print(output, await runtime.doctor());
  else await commandStatus(runtime, output);
}

async function commandSmoke(
  runtime: McpRuntime,
  output: NodeJS.WritableStream,
): Promise<void> {
  const result = await safely(() =>
    runtime.yahoo.get("users;use_login=1/games"),
  );
  print(output, result.structuredContent ?? result);
  if (result.isError) throw new Error("Yahoo read-only smoke test failed");
}

/** Execute a CLI command. No command prints protocol chatter to stdout. */
export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<void> {
  const command = argv[0] ?? "serve";
  const writable = dependencies.output ?? output;
  if (command === "help" || command === "--help" || command === "-h") {
    print(
      writable,
      "Usage: yahoo-fantasy-mcp [auth|status|logout|doctor|smoke|serve]\nWithout a command, serve MCP over stdio.\n\nHTTP: yahoo-fantasy-mcp serve --transport http [--host HOST] [--port PORT] [--path PATH] [--response-mode auto|sse|json]",
    );
    return;
  }
  const readable = dependencies.input ?? input;
  switch (command) {
    case "serve": {
      const serveArguments = parseServeArguments(argv.slice(1));
      const runtime = await (dependencies.loadRuntime ?? loadDefaultRuntime)();
      if (serveArguments.transport === "http") {
        const config = loadHttpConfig(process.env, serveArguments);
        const server = await (
          dependencies.serveHttp ??
          ((value: McpRuntime, httpConfig: HttpConfig) =>
            serveYahooFantasyHttp(value, { config: httpConfig }))
        )(runtime, config);
        const shutdown = (): void => {
          void server.close();
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
        try {
          await server.closed;
        } finally {
          process.off("SIGINT", shutdown);
          process.off("SIGTERM", shutdown);
        }
        return;
      }
      const server = (
        dependencies.serve ?? ((value: McpRuntime) => serveYahooFantasy(value))
      )(runtime);
      // Keep the promise alive until stdin closes. serveStdio owns protocol
      // lifecycle and closes itself when the transport reaches EOF.
      await new Promise<void>((resolve) => {
        const stream = readable as NodeJS.ReadableStream & {
          once(event: string, listener: () => void): unknown;
        };
        stream.once("close", resolve);
        stream.once("end", resolve);
      });
      await server.close();
      return;
    }
    case "auth":
    case "status":
    case "logout":
    case "doctor":
    case "smoke": {
      const runtime = await (dependencies.loadRuntime ?? loadDefaultRuntime)();
      switch (command) {
        case "auth":
          return auth(runtime, readable, writable);
        case "status":
          return commandStatus(runtime, writable);
        case "logout":
          return commandLogout(runtime, writable);
        case "doctor":
          return commandDoctor(runtime, writable);
        case "smoke":
          return commandSmoke(runtime, writable);
      }
      return;
    }
    default:
      throw new Error(
        `Unknown command ${JSON.stringify(command)}; use --help for usage`,
      );
  }
}

function isDirectInvocation(invokedPath: string | undefined): boolean {
  if (!invokedPath) return false;
  try {
    // npm global bins are symlinks. Resolve both sides so the installed
    // executable and `node dist/cli.js` behave identically.
    return (
      realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1])) {
  runCli().catch((error: unknown) => {
    const details = errorPayload(error);
    console.error(
      `${String(details.code)}: ${String(details.message)}\nAction: ${String(details.action)}`,
    );
    process.exitCode = 1;
  });
}
