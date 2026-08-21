import type { CallToolResult } from "@modelcontextprotocol/server";
import type { YahooResponse } from "../yahoo/client.js";
import { redactedMessage, YahooError } from "../yahoo/errors.js";

export class YahooToolError extends Error {
  public readonly code: string;
  public readonly status: number | undefined;

  public constructor(message: string, code = "YAHOO_ERROR", status?: number) {
    super(message);
    this.name = "YahooToolError";
    this.code = code;
    this.status = status;
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
    validation: "INVALID_ARGUMENT",
  };
  return codes[error.kind];
}

export function normalizeError(error: unknown): YahooToolError {
  if (error instanceof YahooToolError) return error;
  if (error instanceof YahooError)
    return new YahooToolError(
      redactedMessage(error),
      errorCode(error),
      error.status,
    );
  return new YahooToolError(redactedMessage(error));
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
    const normalized = normalizeError(error);
    const payload = {
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.status === undefined
          ? {}
          : { status: normalized.status }),
      },
    };
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
