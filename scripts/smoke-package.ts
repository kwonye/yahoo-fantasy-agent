import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { toolNames } from "../src/mcp/tools.js";

// Run against an immutable published version, or a packed tarball in CI before publishing.
const manifest = JSON.parse(
  await readFile(new URL("../plugin.json", import.meta.url), "utf8"),
) as { version: string };
const input = process.argv[2];
const specifier = input
  ? resolve(input)
  : `@kwonye/yahoo-fantasy-mcp@${manifest.version}`;
const temporary = await mkdtemp(
  join(tmpdir(), "yahoo installed package with spaces "),
);
const prefix = join(temporary, "prefix");
const data = join(temporary, "private data");
await mkdir(data);
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  YAHOO_FANTASY_DATA_DIR: data,
  YAHOO_CLIENT_ID: "",
  YAHOO_CLIENT_SECRET: "",
  YAHOO_TOKEN_PATH: join(data, "token.json"),
  npm_config_cache: join(temporary, "npm-cache"),
};
delete environment.PLUGIN_DATA;
delete environment.NODE_PATH;
execFileSync(
  "npm",
  ["install", "--global", "--ignore-scripts", "--prefix", prefix, specifier],
  { cwd: temporary, env: environment, stdio: "inherit" },
);
const executable =
  process.platform === "win32"
    ? join(prefix, "yahoo-fantasy-mcp.cmd")
    : join(prefix, "bin/yahoo-fantasy-mcp");
const help = execFileSync(executable, ["--help"], {
  cwd: temporary,
  env: environment,
  encoding: "utf8",
});
if (!help.includes("Usage: yahoo-fantasy-mcp"))
  throw new Error("Installed CLI help failed");
async function smoke(command: string, args: string[]): Promise<void> {
  const client = new Client({
    name: "installed-agent-smoke",
    version: "1.0.0",
  });
  const env = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: temporary,
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined);
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    if (
      JSON.stringify(listed.tools.map((t) => t.name).sort()) !==
      JSON.stringify([...toolNames].sort())
    )
      throw new Error("Installed package has an incomplete tool catalog");
    const result = await client.callTool({
      name: "yahoo_diagnose",
      arguments: {},
    });
    if (
      result.isError ||
      (result.structuredContent as Record<string, unknown> | undefined)
        ?.ready !== false ||
      (result.structuredContent as Record<string, unknown> | undefined)
        ?.dataDirectory !== data
    )
      throw new Error(
        "Missing-credentials handshake or persistent path diagnosis failed",
      );
    console.log(
      `${command === "npx" ? "npx" : "global"}: ${listed.tools.length} tools, clean handshake, shared persistent storage`,
    );
  } finally {
    await client.close();
  }
}
await smoke(executable, []);
// Registry mode uses the exact production manifest arguments. Tarball mode tests
// npm exec installation plumbing before the new version exists in the registry.
const config = JSON.parse(
  await readFile(new URL("../mcp.json", import.meta.url), "utf8"),
) as { mcpServers: Record<string, { command: string; args: string[] }> };
const server = config.mcpServers["yahoo-fantasy"]!;
await smoke(
  server.command,
  input ? ["--yes", "--package", specifier, "yahoo-fantasy-mcp"] : server.args,
);
console.log(`Verified isolated package installation in ${temporary}`);
