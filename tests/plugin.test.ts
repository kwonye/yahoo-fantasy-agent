import packageJson from "../package.json" with { type: "json" };
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { packPlugin, pluginFiles, validatePlugin } from "../scripts/plugin.js";

describe("portable npm-backed plugin", () => {
  it("validates the portable spec, Codex compatibility, skill discovery, and references", async () => {
    expect(await validatePlugin()).toBe(packageJson.version);
  });
  it("rejects source launchers and mismatched published versions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "plugin-invalid-"));
    for (const name of pluginFiles)
      await cp(name, join(directory, name), { recursive: true });
    const config = JSON.parse(
      await readFile(join(directory, ".mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, { command: string; args: string[] }> };
    config.mcpServers["yahoo-fantasy"]!.command = "node";
    config.mcpServers["yahoo-fantasy"]!.args = ["./dist/cli.js"];
    await writeFile(join(directory, ".mcp.json"), JSON.stringify(config));
    await expect(validatePlugin(directory)).rejects.toThrow(
      "published package",
    );
  });
  it("builds a self-contained plugin archive without source, dependencies, or private data", async () => {
    const destination = await mkdtemp(join(tmpdir(), "plugin-artifact-"));
    const archive = await packPlugin(destination);
    const listing = execFileSync("tar", ["-tzf", archive], {
      encoding: "utf8",
    });
    expect(listing).toContain("yahoo-fantasy-agent/plugin.json");
    expect(listing).toContain("skills/fantasy-football/SKILL.md");
    expect(listing).not.toMatch(
      /node_modules|\/src\/|\/dist\/|\.env|token\.json/,
    );
    const extracted = join(destination, "extracted");
    await mkdir(extracted);
    execFileSync("tar", ["-xzf", archive, "-C", extracted]);
    expect(await validatePlugin(join(extracted, "yahoo-fantasy-agent"))).toBe(
      "1.1.0",
    );
    expect(await readdir(extracted)).toEqual(["yahoo-fantasy-agent"]);
  });
});
