import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { YahooToolError } from "../mcp/helpers.js";
import type { Scope, TeamState } from "./schema.js";

export function agentError(
  code: string,
  message: string,
  action = "Refresh Yahoo context and reevaluate; do not repeat a write blindly",
): YahooToolError {
  return new YahooToolError(message, code, { action, retryable: false });
}
export function fingerprint(value: unknown): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, child]) => [k, stable(child)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

/** One account/season/team per file, with an interprocess heartbeat lock. */
export class AgentStore {
  public constructor(public readonly directory: string) {}
  public async withTeam<T>(
    scope: Scope,
    fn: (state: TeamState, save: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${fingerprint(scope)}.json`);
    let compromised = false;
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(path, {
        realpath: false,
        stale: 120_000,
        update: 10_000,
        retries: 0,
        onCompromised: () => {
          compromised = true;
        },
      });
    } catch {
      throw agentError(
        "AGENT_BUSY",
        "Another process holds this team's storage lock",
        "Wait for the current operation to finish; crashed-process locks expire after two minutes",
      );
    }
    try {
      let state: TeamState;
      try {
        const raw: unknown = JSON.parse(await readFile(path, "utf8"));
        if (
          !raw ||
          typeof raw !== "object" ||
          !("version" in raw) ||
          raw.version !== 1 ||
          !("scope" in raw) ||
          fingerprint(raw.scope) !== fingerprint(scope)
        )
          throw new Error("Invalid state version or scope");
        state = raw as TeamState;
        if (
          !Array.isArray(state.actions) ||
          !Array.isArray(state.runs) ||
          !Array.isArray(state.preflights)
        )
          throw new Error("Invalid journal");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw agentError(
            "AGENT_STATE_ERROR",
            "Cannot read the team journal; it has not been reset",
            "Repair or restore the journal before resuming management",
          );
        state = {
          version: 1,
          scope,
          profile: null,
          runs: [],
          preflights: [],
          actions: [],
        };
      }
      const save = async (): Promise<void> => {
        if (compromised)
          throw agentError(
            "AGENT_BUSY",
            "Storage lock was lost; stop this run",
          );
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          const file = await open(temporary, "wx", 0o600);
          try {
            await file.writeFile(JSON.stringify(state) + "\n");
            await file.sync();
          } finally {
            await file.close();
          }
          if (compromised)
            throw agentError(
              "AGENT_BUSY",
              "Storage lock was lost; stop this run",
            );
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
      };
      return await fn(state, save);
    } finally {
      await release().catch(() => undefined);
    }
  }
}
