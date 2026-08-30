import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SecureTokenStore,
  tokenFromResponse,
} from "../src/yahoo/token-store.js";

describe("SecureTokenStore", () => {
  it("preserves millisecond expiresAt values across atomic persistence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yahoo-mcp-token-"));
    const path = join(directory, "nested", "token.json");
    const store = new SecureTokenStore(path);
    const token = tokenFromResponse(
      { access_token: "access", refresh_token: "refresh", expires_in: 3600 },
      1000,
    );
    await store.write(token);
    expect(await store.read()).toEqual(token);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).not.toContain("access_token");
    await store.clear();
    expect(await store.read()).toBeNull();
  });

  it("uses a newly rotated refresh token", () => {
    const token = tokenFromResponse(
      {
        access_token: "new",
        refresh_token: "rotated",
        expires_at: 2_000_000_000,
      },
      1000,
    );
    expect(token.refreshToken).toBe("rotated");
    expect(token.expiresAt).toBe(2_000_000_000_000);
  });

  it("classifies corrupt token files as token-store failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yahoo-mcp-token-"));
    const path = join(directory, "token.json");
    await writeFile(path, "not json", "utf8");
    const store = new SecureTokenStore(path);
    await expect(store.read()).rejects.toMatchObject({
      name: "YahooError",
      kind: "token_store",
    });
  });
});
