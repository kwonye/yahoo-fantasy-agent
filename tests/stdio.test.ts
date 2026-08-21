import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";
import { toolNames } from "../src/mcp/tools.js";

describe("stdio executable", () => {
  it("starts as a real process and serves the complete MCP tool list", async () => {
    const client = new Client({ name: "stdio-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/cli.ts"],
      env: {
        ...getDefaultEnvironment(),
        YAHOO_CLIENT_ID: "stdio-test-client",
        YAHOO_CLIENT_SECRET: "stdio-test-secret",
        YAHOO_REDIRECT_URI: "oob",
      },
      stderr: "pipe",
    });

    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [...toolNames].sort(),
      );
    } finally {
      await client.close();
    }
  }, 10_000);
});
