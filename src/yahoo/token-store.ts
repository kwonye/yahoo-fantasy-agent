import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

export interface YahooToken {
  accessToken: string;
  refreshToken?: string | undefined;
  tokenType: string;
  expiresAt?: number | undefined;
  scope?: string | undefined;
  createdAt: number;
}

export interface YahooTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number | string;
  expires_at?: number | string;
  scope?: string;
  [key: string]: unknown;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Convert Yahoo's snake-case OAuth response into our non-secret internal form. */
export function tokenFromResponse(
  response: YahooTokenResponse,
  now = Date.now(),
): YahooToken {
  if (
    typeof response.access_token !== "string" ||
    response.access_token.trim() === ""
  ) {
    throw new Error("Yahoo OAuth response did not include an access token");
  }
  const expiresAtRaw = numberOrUndefined(response.expires_at);
  const expiresIn = numberOrUndefined(response.expires_in);
  const expiresAt =
    expiresAtRaw === undefined
      ? expiresIn === undefined
        ? undefined
        : now + expiresIn * 1000
      : expiresAtRaw < 10_000_000_000
        ? expiresAtRaw * 1000
        : expiresAtRaw;

  return {
    accessToken: response.access_token,
    refreshToken:
      typeof response.refresh_token === "string" &&
      response.refresh_token.trim() !== ""
        ? response.refresh_token
        : undefined,
    tokenType:
      typeof response.token_type === "string" &&
      response.token_type.trim() !== ""
        ? response.token_type
        : "Bearer",
    expiresAt,
    scope: typeof response.scope === "string" ? response.scope : undefined,
    createdAt: now,
  };
}

function parseToken(raw: unknown): YahooToken {
  if (!raw || typeof raw !== "object")
    throw new Error("Yahoo token file is not a JSON object");
  const value = raw as Record<string, unknown>;
  const accessToken =
    typeof value.accessToken === "string"
      ? value.accessToken
      : value.access_token;
  if (typeof accessToken !== "string" || accessToken.trim() === "")
    throw new Error("Yahoo token file has no access token");
  const refreshToken =
    typeof value.refreshToken === "string"
      ? value.refreshToken
      : value.refresh_token;
  // Our persisted camel-case value is always epoch milliseconds. Only the
  // legacy Yahoo snake-case form may be epoch seconds.
  const persistedExpiresAt = numberOrUndefined(value.expiresAt);
  const legacyExpiresAt = numberOrUndefined(value.expires_at);
  const createdAt = numberOrUndefined(value.createdAt) ?? Date.now();
  return {
    accessToken,
    refreshToken:
      typeof refreshToken === "string" && refreshToken.trim() !== ""
        ? refreshToken
        : undefined,
    tokenType:
      typeof value.tokenType === "string"
        ? value.tokenType
        : typeof value.token_type === "string"
          ? value.token_type
          : "Bearer",
    expiresAt:
      persistedExpiresAt ??
      (legacyExpiresAt === undefined
        ? undefined
        : legacyExpiresAt < 10_000_000_000
          ? legacyExpiresAt * 1000
          : legacyExpiresAt),
    scope: typeof value.scope === "string" ? value.scope : undefined,
    createdAt,
  };
}

/**
 * Owner-readable token persistence. Writes are made to a same-directory
 * temporary file and atomically renamed, so a process crash cannot leave a
 * half-written credential behind.
 */
export class SecureTokenStore {
  public constructor(public readonly path: string) {}

  public async read(): Promise<YahooToken | null> {
    try {
      const content = await readFile(this.path, "utf8");
      return parseToken(JSON.parse(content) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(
        `Unable to read Yahoo token store: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  public async write(token: YahooToken): Promise<void> {
    if (!token.accessToken)
      throw new Error("Cannot persist an empty Yahoo access token");
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);

    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const serialized = JSON.stringify(token, null, 2) + "\n";
    try {
      await writeFile(temporaryPath, serialized, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new Error(
        `Unable to write Yahoo token store: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  public async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
