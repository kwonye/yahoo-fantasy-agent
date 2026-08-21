#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { loadDefaultRuntime, serveYahooFantasy } from "./index.js";
import { safely, stringify } from "./mcp/helpers.js";
import type { McpRuntime } from "./mcp/types.js";

export interface CliDependencies {
  loadRuntime?: () => Promise<McpRuntime>;
  serve?: (runtime: McpRuntime) => { close(): Promise<void> };
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
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
      "Usage: yahoo-fantasy-mcp [auth|status|logout|doctor|smoke]\nWithout a command, serve MCP over stdio.",
    );
    return;
  }
  const runtime = await (dependencies.loadRuntime ?? loadDefaultRuntime)();
  const readable = dependencies.input ?? input;
  switch (command) {
    case "serve": {
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
      return auth(runtime, readable, writable);
    case "status":
      return commandStatus(runtime, writable);
    case "logout":
      return commandLogout(runtime, writable);
    case "doctor":
      return commandDoctor(runtime, writable);
    case "smoke":
      return commandSmoke(runtime, writable);
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
