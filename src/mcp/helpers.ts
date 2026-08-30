import type { CallToolResult } from "@modelcontextprotocol/server";
import type { YahooResponse } from "../yahoo/client.js";
import { redactedMessage, YahooError } from "../yahoo/errors.js";

export interface YahooToolErrorOptions {
  readonly status?: number;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly action?: string;
  readonly retryable?: boolean;
}

interface ErrorAdvice {
  readonly action: string;
  readonly retryable: boolean;
}

function adviceForCode(code: string, retryAfterMs?: number): ErrorAdvice {
  switch (code) {
    case "CONFIGURATION_ERROR":
      return {
        action:
          "Set YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET in the MCP server environment, restart the server, then run `yahoo-fantasy-mcp auth`.",
        retryable: false,
      };
    case "AUTH_REQUIRED":
      return {
        action:
          "Run `yahoo-fantasy-mcp auth` to authenticate or re-authenticate, then retry this tool.",
        retryable: false,
      };
    case "TOKEN_STORE_ERROR":
      return {
        action:
          "Verify YAHOO_TOKEN_PATH is readable and writable, run `yahoo-fantasy-mcp logout`, then run `yahoo-fantasy-mcp auth`.",
        retryable: false,
      };
    case "FORBIDDEN":
      return {
        action:
          "Check that the Yahoo application is approved for private Fantasy Sports data with the required Read/Write access and that the account can access this resource.",
        retryable: false,
      };
    case "INVALID_ARGUMENT":
      return {
        action:
          "Review the tool arguments and use the documented Yahoo key and format requirements, then retry.",
        retryable: false,
      };
    case "NOT_FOUND":
      return {
        action:
          "Verify the Yahoo game, league, team, player, or transaction key and make sure it belongs to the current season and account.",
        retryable: false,
      };
    case "RATE_LIMITED":
      return {
        action:
          retryAfterMs === undefined
            ? "Wait briefly before retrying the request."
            : `Wait at least ${Math.max(1, Math.ceil(retryAfterMs / 1000))} seconds before retrying the request.`,
        retryable: true,
      };
    case "NETWORK_ERROR":
      return {
        action:
          "Check network access and DNS resolution for Yahoo, then retry; if it persists, run `yahoo-fantasy-mcp doctor`.",
        retryable: true,
      };
    case "INVALID_RESPONSE":
      return {
        action:
          "Retry the request. If Yahoo continues returning an unexpected response, run `yahoo-fantasy-mcp doctor` and report the request id if present.",
        retryable: true,
      };
    case "YAHOO_ERROR":
    default:
      return {
        action:
          "Retry the request. If it continues to fail, run `yahoo-fantasy-mcp doctor` and use the reported status and request id to investigate.",
        retryable: true,
      };
  }
}

export class YahooToolError extends Error {
  public readonly code: string;
  public readonly status: number | undefined;
  public readonly requestId: string | undefined;
  public readonly retryAfterMs: number | undefined;
  public readonly action: string;
  public readonly retryable: boolean;

  public constructor(
    message: string,
    code = "YAHOO_ERROR",
    statusOrOptions?: number | YahooToolErrorOptions,
    options: YahooToolErrorOptions = {},
  ) {
    super(message);
    this.name = "YahooToolError";
    this.code = code;
    const metadata =
      typeof statusOrOptions === "number"
        ? options
        : (statusOrOptions ?? options);
    this.status =
      typeof statusOrOptions === "number" ? statusOrOptions : metadata.status;
    this.requestId = metadata.requestId;
    this.retryAfterMs = metadata.retryAfterMs;
    const advice = adviceForCode(code, metadata.retryAfterMs);
    this.action = metadata.action ?? advice.action;
    this.retryable = metadata.retryable ?? advice.retryable;
  }
}

function encodeValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed)
    throw new YahooToolError(
      "Yahoo keys and filter values must not be empty",
      "INVALID_ARGUMENT",
    );
  return encodeURIComponent(trimmed).replaceAll("%2C", ",");
}

export function key(value: string, label: string): string {
  if (/[\r\n]/.test(value) || !value.trim())
    throw new YahooToolError(
      `${label} must be a non-empty Yahoo key`,
      "INVALID_KEY",
    );
  return encodeValue(value);
}

export function resourcePath(
  resource: "game" | "league" | "team" | "player" | "transaction",
  resourceKey: string,
  subresource?: string,
): string {
  const base = `${resource}/${key(resourceKey, `${resource}Key`)}`;
  return subresource ? `${base}/${subresource}` : base;
}

export function userPath(resource: "games" | "leagues" | "teams"): string {
  return `users;use_login=1/${resource}`;
}

export function matrix(
  path: string,
  values: Readonly<Record<string, unknown>>,
): string {
  const suffix = Object.entries(values)
    .filter(
      (entry) => entry[1] !== undefined && entry[1] !== null && entry[1] !== "",
    )
    .map(([name, value]) => `${name}=${encodeValue(String(value))}`)
    .join(";");
  return suffix ? `${path};${suffix}` : path;
}

export function appendQuery(
  path: string,
  values: Readonly<Record<string, string | number | boolean>>,
): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(values))
    query.set(name, String(value));
  if (query.size === 0) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${query.toString()}`;
}

export function safeAdvancedPath(input: string): string {
  let path = input.trim();
  if (
    !path ||
    /[\r\n\\]/.test(path) ||
    /^[a-z][a-z\d+.-]*:/i.test(path) ||
    path.startsWith("//")
  ) {
    throw new YahooToolError(
      "path must be a relative Yahoo Fantasy API path",
      "INVALID_PATH",
    );
  }
  path = path.replace(/^\/?fantasy\/v2\/?/i, "").replace(/^\/+/, "");
  if (
    !path ||
    path.split("/").includes("..") ||
    !/^(?:users|user|game|games|league|leagues|team|teams|player|players|transaction|transactions)(?:[/?;]|$)/i.test(
      path,
    )
  ) {
    throw new YahooToolError(
      "path must address a resource under /fantasy/v2",
      "INVALID_PATH",
    );
  }
  return path;
}

function errorCode(error: YahooError): string {
  const codes: Record<YahooError["kind"], string> = {
    authentication: "AUTH_REQUIRED",
    configuration: "CONFIGURATION_ERROR",
    network: "NETWORK_ERROR",
    not_found: "NOT_FOUND",
    parse: "INVALID_RESPONSE",
    permission: "FORBIDDEN",
    rate_limit: "RATE_LIMITED",
    upstream: "YAHOO_ERROR",
    token_store: "TOKEN_STORE_ERROR",
    validation: "INVALID_ARGUMENT",
  };
  return codes[error.kind];
}

export function normalizeError(error: unknown): YahooToolError {
  if (error instanceof YahooToolError) return error;
  if (error instanceof YahooError)
    return new YahooToolError(redactedMessage(error), errorCode(error), {
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      ...(error.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: error.retryAfterMs }),
    });
  return new YahooToolError(redactedMessage(error));
}

export function errorPayload(error: unknown): Record<string, unknown> {
  const normalized = normalizeError(error);
  return {
    code: normalized.code,
    message: normalized.message,
    action: normalized.action,
    retryable: normalized.retryable,
    ...(normalized.status === undefined ? {} : { status: normalized.status }),
    ...(normalized.requestId === undefined
      ? {}
      : { requestId: normalized.requestId }),
    ...(normalized.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: normalized.retryAfterMs }),
  };
}

function result(data: unknown): CallToolResult {
  const structuredContent =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { data };
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent,
  };
}

export async function safely(
  operation: () => Promise<unknown>,
): Promise<CallToolResult> {
  try {
    const value = await operation();
    if (
      typeof value === "object" &&
      value !== null &&
      "data" in value &&
      "status" in value
    ) {
      return result((value as YahooResponse).data);
    }
    return result(value);
  } catch (error) {
    const payload = { error: errorPayload(error) };
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  }
}

export function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}
