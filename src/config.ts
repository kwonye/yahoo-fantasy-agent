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

export type HttpResponseMode = "auto" | "sse" | "json";

/** Configuration for the optional MCP Streamable HTTP listener. */
export interface HttpConfig {
  host: string;
  port: number;
  path: string;
  responseMode: HttpResponseMode;
  token?: string;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
}

export interface HttpConfigOverrides {
  host?: string;
  port?: number;
  path?: string;
  responseMode?: HttpResponseMode;
  token?: string;
  allowedHosts?: readonly string[];
  allowedOrigins?: readonly string[];
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
  readonly MCP_HTTP_HOST?: string;
  readonly MCP_HTTP_PORT?: string;
  readonly MCP_HTTP_PATH?: string;
  readonly MCP_HTTP_RESPONSE_MODE?: string;
  readonly MCP_HTTP_TOKEN?: string;
  readonly MCP_HTTP_ALLOWED_HOSTS?: string;
  readonly MCP_HTTP_ALLOWED_ORIGINS?: string;
  readonly XDG_CONFIG_HOME?: string;
}

const DEFAULT_API_BASE_URL = "https://fantasysports.yahooapis.com/fantasy/v2";
const DEFAULT_OAUTH_BASE_URL = "https://api.login.yahoo.com";
const DEFAULT_REDIRECT_URI = "oob";
const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 3000;
const DEFAULT_HTTP_PATH = "/mcp";
const DEFAULT_HTTP_RESPONSE_MODE: HttpResponseMode = "auto";
const LOCALHOST_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"] as const;
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

function boundedPort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(
      `HTTP port must be an integer between 0 and 65535, received ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

function nonEmpty(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function normalizePath(value: string | undefined, fallback: string): string {
  const path = nonEmpty(value, fallback);
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw new Error(
      `MCP HTTP path must start with / and contain no query or fragment, received ${JSON.stringify(path)}`,
    );
  }
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function csv(value: string | undefined): readonly string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function responseMode(value: string | undefined): HttpResponseMode {
  const mode = value?.trim() || DEFAULT_HTTP_RESPONSE_MODE;
  if (mode !== "auto" && mode !== "sse" && mode !== "json") {
    throw new Error(
      `MCP HTTP response mode must be auto, sse, or json, received ${JSON.stringify(mode)}`,
    );
  }
  return mode;
}

function normalizedHost(host: string): string {
  return host.toLowerCase() === "::1" ? "[::1]" : host;
}

export function isLoopbackHost(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
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

/**
 * Resolve and validate the optional MCP Streamable HTTP listener configuration.
 * The bearer token is intentionally environment-only so it cannot leak through
 * process listings or shell history.
 */
export function loadHttpConfig(
  environment: ConfigEnvironment = process.env,
  overrides: HttpConfigOverrides = {},
): HttpConfig {
  const requestedHost = nonEmpty(
    overrides.host ?? environment.MCP_HTTP_HOST,
    DEFAULT_HTTP_HOST,
  );
  const host = requestedHost.toLowerCase() === "[::1]" ? "::1" : requestedHost;
  const port =
    overrides.port ?? boundedPort(environment.MCP_HTTP_PORT, DEFAULT_HTTP_PORT);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`MCP HTTP port must be an integer between 0 and 65535`);
  }
  const path = normalizePath(
    overrides.path ?? environment.MCP_HTTP_PATH,
    DEFAULT_HTTP_PATH,
  );
  const mode = responseMode(
    overrides.responseMode ?? environment.MCP_HTTP_RESPONSE_MODE,
  );
  const tokenValue = overrides.token ?? environment.MCP_HTTP_TOKEN;
  const token = tokenValue?.trim() || undefined;
  const configuredHosts =
    overrides.allowedHosts ?? csv(environment.MCP_HTTP_ALLOWED_HOSTS);
  const configuredOrigins =
    overrides.allowedOrigins ?? csv(environment.MCP_HTTP_ALLOWED_ORIGINS);
  const loopback = isLoopbackHost(host);
  const allowedHosts = configuredHosts.length
    ? configuredHosts.map(normalizedHost)
    : loopback
      ? LOCALHOST_HOSTNAMES
      : [];
  const allowedOrigins = configuredOrigins.length
    ? configuredOrigins.map(normalizedHost)
    : loopback
      ? LOCALHOST_HOSTNAMES
      : [];

  if (!loopback && !token) {
    throw new Error(
      "MCP_HTTP_TOKEN is required when MCP HTTP binds beyond loopback",
    );
  }
  if (!loopback && allowedHosts.length === 0) {
    throw new Error(
      "MCP_HTTP_ALLOWED_HOSTS is required when MCP HTTP binds beyond loopback",
    );
  }

  return {
    host,
    port,
    path,
    responseMode: mode,
    ...(token === undefined ? {} : { token }),
    allowedHosts,
    allowedOrigins,
  };
}

export const yahooDefaults = {
  apiBaseUrl: DEFAULT_API_BASE_URL,
  oauthBaseUrl: DEFAULT_OAUTH_BASE_URL,
  redirectUri: DEFAULT_REDIRECT_URI,
  scopes: DEFAULT_SCOPES,
} as const;
