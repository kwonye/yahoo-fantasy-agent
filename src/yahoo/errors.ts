export type YahooErrorKind =
  | "configuration"
  | "authentication"
  | "permission"
  | "validation"
  | "not_found"
  | "rate_limit"
  | "upstream"
  | "network"
  | "parse";

export interface YahooErrorOptions {
  readonly status?: number;
  readonly endpoint?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

function redact(value: string): string {
  return value
    .replace(/(Bearer|Basic)\s+[^\s"']+/gi, "$1 [REDACTED]")
    .replace(
      /(access_token|refresh_token|client_secret|client_secret_basic|authorization)\s*=\s*[^&\s]+/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /(access_token|refresh_token|client_secret|authorization)["']?\s*[:=]\s*["']?[^,"'\s}]+/gi,
      "$1=[REDACTED]",
    );
}

export class YahooError extends Error {
  public readonly kind: YahooErrorKind;
  public readonly status: number | undefined;
  public readonly endpoint: string | undefined;
  public readonly requestId: string | undefined;
  public readonly retryAfterMs: number | undefined;

  public constructor(
    kind: YahooErrorKind,
    message: string,
    options: YahooErrorOptions = {},
  ) {
    super(redact(message), { cause: options.cause });
    this.name = "YahooError";
    this.kind = kind;
    this.status = options.status;
    this.endpoint = options.endpoint;
    this.requestId = options.requestId;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function classifyYahooStatus(status: number): YahooErrorKind {
  if (status === 401) return "authentication";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 400 || status === 409 || status === 422) return "validation";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "upstream";
  return "upstream";
}

export function asYahooError(
  error: unknown,
  fallbackKind: YahooErrorKind = "upstream",
): YahooError {
  if (error instanceof YahooError) return error;
  if (error instanceof Error)
    return new YahooError(fallbackKind, error.message, { cause: error });
  return new YahooError(fallbackKind, String(error));
}

export function redactedMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}
