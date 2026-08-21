import { homedir } from "node:os";
import { join } from "node:path";

/** Environment variables and defaults used by the Yahoo integration. */
export interface YahooConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: readonly string[];
  apiBaseUrl: string;
  oauthBaseUrl: string;
  tokenPath: string;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  maxGetRetries: number;
}

export interface ConfigEnvironment {
  readonly YAHOO_CLIENT_ID?: string;
  readonly YAHOO_CLIENT_SECRET?: string;
  readonly YAHOO_REDIRECT_URI?: string;
  readonly YAHOO_SCOPE?: string;
  readonly YAHOO_API_BASE_URL?: string;
  readonly YAHOO_OAUTH_BASE_URL?: string;
  readonly YAHOO_TOKEN_PATH?: string;
  readonly YAHOO_REQUEST_TIMEOUT_MS?: string;
  readonly YAHOO_MAX_RESPONSE_BYTES?: string;
  readonly YAHOO_MAX_GET_RETRIES?: string;
  readonly XDG_CONFIG_HOME?: string;
}

const DEFAULT_API_BASE_URL = "https://fantasysports.yahooapis.com/fantasy/v2";
const DEFAULT_OAUTH_BASE_URL = "https://api.login.yahoo.com";
const DEFAULT_REDIRECT_URI = "oob";
// Yahoo's Fantasy Read/Write permission is granted on the application itself;
// Yahoo currently does not require a scope parameter for this API. Keep the
// query parameter opt-in for applications that explicitly configure one.
const DEFAULT_SCOPES = [] as const;

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Configuration value must be a positive integer, received ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed)
    throw new Error(
      `${name} is required; set it in the environment before starting Yahoo Fantasy MCP`,
    );
  return trimmed;
}

/**
 * Read configuration without loading a dotenv file. The command-line entry
 * point may load dotenv if desired, while library consumers can pass a
 * deterministic environment object in tests.
 */
export function loadConfig(
  environment: ConfigEnvironment = process.env,
): YahooConfig {
  const configHome =
    environment.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  const tokenPath =
    environment.YAHOO_TOKEN_PATH?.trim() ||
    join(configHome, "yahoo-fantasy-mcp", "token.json");
  const scopes = (environment.YAHOO_SCOPE?.trim() || DEFAULT_SCOPES.join(" "))
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

  return {
    clientId: required(environment.YAHOO_CLIENT_ID, "YAHOO_CLIENT_ID"),
    clientSecret: required(
      environment.YAHOO_CLIENT_SECRET,
      "YAHOO_CLIENT_SECRET",
    ),
    redirectUri: environment.YAHOO_REDIRECT_URI?.trim() || DEFAULT_REDIRECT_URI,
    scopes,
    apiBaseUrl: (
      environment.YAHOO_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL
    ).replace(/\/+$/, ""),
    oauthBaseUrl: (
      environment.YAHOO_OAUTH_BASE_URL?.trim() || DEFAULT_OAUTH_BASE_URL
    ).replace(/\/+$/, ""),
    tokenPath,
    requestTimeoutMs: positiveInteger(
      environment.YAHOO_REQUEST_TIMEOUT_MS,
      30_000,
    ),
    maxResponseBytes: positiveInteger(
      environment.YAHOO_MAX_RESPONSE_BYTES,
      8 * 1024 * 1024,
    ),
    maxGetRetries: positiveInteger(environment.YAHOO_MAX_GET_RETRIES, 3),
  };
}

export const yahooDefaults = {
  apiBaseUrl: DEFAULT_API_BASE_URL,
  oauthBaseUrl: DEFAULT_OAUTH_BASE_URL,
  redirectUri: DEFAULT_REDIRECT_URI,
  scopes: DEFAULT_SCOPES,
} as const;
