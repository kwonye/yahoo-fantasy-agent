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

  it("keeps serving and explains missing Yahoo credentials", async () => {
    const client = new Client({
      name: "stdio-missing-config-test",
      version: "1.0.0",
    });
    const env = Object.fromEntries(
      Object.entries(getDefaultEnvironment()).filter(
        ([key]) => key !== "YAHOO_CLIENT_ID" && key !== "YAHOO_CLIENT_SECRET",
      ),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/cli.ts"],
      env,
      stderr: "pipe",
    });

    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.some((tool) => tool.name === "yahoo_diagnose")).toBe(true);

      const diagnosis = await client.callTool({
        name: "yahoo_diagnose",
        arguments: {},
      });
      expect(diagnosis.isError).not.toBe(true);
      expect(diagnosis).toMatchObject({
        structuredContent: {
          ready: false,
          configuration: {
            configured: false,
            missing: ["YAHOO_CLIENT_ID", "YAHOO_CLIENT_SECRET"],
          },
        },
      });
      expect(JSON.stringify(diagnosis.structuredContent)).toContain(
        "YAHOO_CLIENT_ID",
      );

      const result = await client.callTool({
        name: "yahoo_user_games",
        arguments: {},
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: "CONFIGURATION_ERROR",
            retryable: false,
          },
        },
      });
      expect(JSON.stringify(result.structuredContent)).toContain(
        "yahoo-fantasy-mcp auth",
      );
    } finally {
      await client.close();
    }
  }, 10_000);
});
