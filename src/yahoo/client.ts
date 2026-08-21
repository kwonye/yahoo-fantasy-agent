import type { YahooConfig } from "../config.js";
import {
  classifyYahooStatus,
  YahooError,
  type YahooErrorKind,
} from "./errors.js";
import type { YahooOAuth } from "./oauth.js";
import { parseAndNormalizeYahooXml } from "./xml.js";

export interface YahooResponse<T = unknown> {
  readonly status: number;
  readonly requestId?: string;
  readonly data: T;
}

export interface YahooRequestOptions {
  readonly query?: Readonly<
    Record<
      string,
      string | number | boolean | readonly (string | number)[] | undefined
    >
  >;
  readonly signal?: AbortSignal;
  readonly retries?: number;
}

export interface YahooClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_METHODS = new Set(["GET", "HEAD"]);

function safeEndpoint(path: string): string {
  const value = path.trim();
  if (
    !value ||
    value.includes("\\") ||
    value.startsWith("//") ||
    /^[A-Za-z][A-Za-z\d+.-]*:/.test(value)
  ) {
    throw new YahooError(
      "validation",
      "Yahoo API paths must be relative fantasy/v2 paths",
    );
  }
  const normalized = value.replace(/^\/+/, "").replace(/^fantasy\/v2\/?/i, "");
  if (!normalized || normalized.includes(".."))
    throw new YahooError("validation", "Yahoo API path is invalid");
  return normalized;
}

function retryAfterMilliseconds(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(seconds * 1000, 30_000);
  const date = Date.parse(header);
  if (!Number.isNaN(date))
    return Math.max(0, Math.min(date - Date.now(), 30_000));
  return undefined;
}

function contentType(response: Response): string {
  return response.headers.get("content-type")?.toLowerCase() ?? "";
}

export class YahooClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  public constructor(
    private readonly config: YahooConfig,
    private readonly oauth: YahooOAuth,
    options: YahooClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  public get<T = unknown>(
    path: string,
    options: YahooRequestOptions = {},
  ): Promise<YahooResponse<T>> {
    return this.request<T>("GET", path, undefined, options);
  }

  public head<T = unknown>(
    path: string,
    options: YahooRequestOptions = {},
  ): Promise<YahooResponse<T>> {
    return this.request<T>("HEAD", path, undefined, options);
  }

  public post<T = unknown>(
    path: string,
    body: string,
    options: YahooRequestOptions = {},
  ): Promise<YahooResponse<T>> {
    return this.request<T>("POST", path, body, options);
  }

  public put<T = unknown>(
    path: string,
    body: string,
    options: YahooRequestOptions = {},
  ): Promise<YahooResponse<T>> {
    return this.request<T>("PUT", path, body, options);
  }

  public delete<T = unknown>(
    path: string,
    options: YahooRequestOptions = {},
  ): Promise<YahooResponse<T>> {
    return this.request<T>("DELETE", path, undefined, options);
  }

  public async request<T = unknown>(
    method: string,
    path: string,
    body?: string,
    options: YahooRequestOptions = {},
  ): Promise<YahooResponse<T>> {
    const normalizedMethod = method.toUpperCase();
    if (!["GET", "HEAD", "POST", "PUT", "DELETE"].includes(normalizedMethod)) {
      throw new YahooError(
        "validation",
        `Unsupported Yahoo API method: ${normalizedMethod}`,
      );
    }
    if (body !== undefined && typeof body !== "string")
      throw new YahooError("validation", "Yahoo request body must be XML text");
    const endpointPath = safeEndpoint(path);
    const url = new URL(`${this.config.apiBaseUrl}/${endpointPath}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value))
        value.forEach((item) => url.searchParams.append(key, String(item)));
      else url.searchParams.set(key, String(value));
    }

    const maxRetries = RETRYABLE_METHODS.has(normalizedMethod)
      ? Math.max(0, Math.min(options.retries ?? this.config.maxGetRetries, 5))
      : 0;
    let attempt = 0;
    let authenticationRetried = false;
    while (true) {
      const token = await this.oauth.validToken();
      let response: Response;
      try {
        response = await this.fetchWithTimeout(
          url,
          normalizedMethod,
          token.accessToken,
          body,
          options.signal,
        );
      } catch (error) {
        if (attempt < maxRetries && this.isRetryableNetworkError(error)) {
          await this.backoff(attempt);
          attempt += 1;
          continue;
        }
        throw new YahooError(
          "network",
          `Unable to reach Yahoo API (${normalizedMethod} ${endpointPath})`,
          { endpoint: endpointPath, cause: error },
        );
      }

      if (
        response.status === 401 &&
        !authenticationRetried &&
        token.refreshToken &&
        RETRYABLE_METHODS.has(normalizedMethod)
      ) {
        authenticationRetried = true;
        await this.oauth.refresh(token.refreshToken);
        continue;
      }
      if (!response.ok) {
        if (attempt < maxRetries && RETRYABLE_STATUSES.has(response.status)) {
          const retryAfter = retryAfterMilliseconds(
            response.headers.get("retry-after"),
          );
          await this.backoff(attempt, retryAfter);
          attempt += 1;
          continue;
        }
        throw await this.apiError(response, endpointPath);
      }
      const requestId =
        response.headers.get("x-request-id") ??
        response.headers.get("x-yahoo-request-id") ??
        undefined;
      return {
        status: response.status,
        ...(requestId === undefined ? {} : { requestId }),
        data: await this.readBody<T>(response, endpointPath),
      };
    }
  }

  private async fetchWithTimeout(
    url: URL,
    method: string,
    accessToken: string,
    body?: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutMs,
    );
    const forwardAbort = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener("abort", forwardAbort, { once: true });
    try {
      return await this.fetchImpl(url, {
        method,
        signal: controller.signal,
        headers: {
          accept: "application/xml, application/json;q=0.8",
          authorization: `Bearer ${accessToken}`,
          ...(body === undefined
            ? {}
            : { "content-type": "application/xml; charset=utf-8" }),
        },
        ...(body === undefined ? {} : { body }),
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  private async readBody<T>(response: Response, endpoint: string): Promise<T> {
    if (
      response.status === 204 ||
      response.status === 205 ||
      response.body === null
    )
      return null as T;
    let bytes: ArrayBuffer;
    try {
      bytes = await response.arrayBuffer();
    } catch (error) {
      throw new YahooError("network", "Unable to read Yahoo response", {
        endpoint,
        cause: error,
      });
    }
    if (bytes.byteLength > this.config.maxResponseBytes) {
      throw new YahooError(
        "upstream",
        "Yahoo response exceeded the configured size limit",
        { endpoint },
      );
    }
    const text = new TextDecoder().decode(bytes);
    if (text.trim() === "") return null as T;
    try {
      const parsed: unknown =
        contentType(response).includes("json") ||
        !text.trimStart().startsWith("<")
          ? (JSON.parse(text) as unknown)
          : parseAndNormalizeYahooXml(text);
      return parsed as T;
    } catch (error) {
      throw new YahooError(
        "parse",
        `Unable to parse Yahoo response from ${endpoint}`,
        { endpoint, cause: error },
      );
    }
  }

  private async apiError(
    response: Response,
    endpoint: string,
  ): Promise<YahooError> {
    let detail = `Yahoo API request failed (${response.status})`;
    try {
      const bytes = await response.arrayBuffer();
      const text = new TextDecoder().decode(
        bytes.slice(0, Math.min(bytes.byteLength, 8_192)),
      );
      if (text.trim()) {
        try {
          const parsed = text.trimStart().startsWith("<")
            ? parseAndNormalizeYahooXml(text)
            : (JSON.parse(text) as unknown);
          detail = `${detail}: ${this.errorDetail(parsed)}`;
        } catch {
          detail = `${detail}: ${text.slice(0, 500)}`;
        }
      }
    } catch {
      // Keep the status-derived message if Yahoo closes the response early.
    }
    const kind: YahooErrorKind = classifyYahooStatus(response.status);
    const requestId = response.headers.get("x-request-id") ?? undefined;
    const retryAfterMs = retryAfterMilliseconds(
      response.headers.get("retry-after"),
    );
    return new YahooError(kind, detail, {
      status: response.status,
      endpoint,
      ...(requestId === undefined ? {} : { requestId }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }

  private errorDetail(value: unknown): string {
    if (typeof value === "string") return value.slice(0, 500);
    if (!value || typeof value !== "object")
      return "Yahoo returned no additional details";
    const object = value as Record<string, unknown>;
    for (const key of [
      "description",
      "error_description",
      "message",
      "error",
      "_text",
    ]) {
      const candidate = object[key];
      if (typeof candidate === "string") return candidate.slice(0, 500);
    }
    return "Yahoo returned an error response";
  }

  private isRetryableNetworkError(error: unknown): boolean {
    return !(error instanceof YahooError && error.kind === "validation");
  }

  private async backoff(attempt: number, retryAfter?: number): Promise<void> {
    const delay =
      retryAfter ??
      Math.min(10_000, 250 * 2 ** attempt + Math.floor(Math.random() * 100));
    await this.sleep(delay);
  }
}
