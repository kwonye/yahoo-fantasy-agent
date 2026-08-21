import { McpServer } from "@modelcontextprotocol/server";
import packageJson from "../../package.json" with { type: "json" };
import { registerYahooTools } from "./tools.js";
import type { McpRuntime } from "./types.js";

export interface McpServerOptions {
  name?: string;
  version?: string;
}

/** Build a fresh MCP server instance for one stdio connection. */
export function createMcpServer(
  runtime: McpRuntime,
  options: McpServerOptions = {},
): McpServer {
  const server = new McpServer(
    {
      name: options.name ?? packageJson.name,
      version: options.version ?? packageJson.version,
    },
    { capabilities: { tools: {} } },
  );
  registerYahooTools(server, runtime);
  return server;
}

export { registerYahooTools } from "./tools.js";
export type { McpRuntime, YahooApi } from "./types.js";
