import { randomBytes } from "node:crypto";
import type { YahooConfig } from "../config.js";
import { YahooError } from "./errors.js";
import {
  SecureTokenStore,
  tokenFromResponse,
  type YahooToken,
  type YahooTokenResponse,
} from "./token-store.js";

export type FetchLike = typeof fetch;

export interface OAuthExchangeOptions {
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
}

function required(value: string, name: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new YahooError("configuration", `${name} is required`);
  return value.trim();
}

function asOAuthResponse(value: unknown): YahooTokenResponse {
  if (!value || typeof value !== "object")
    throw new YahooError(
      "authentication",
      "Yahoo OAuth returned an invalid response",
    );
  const response = value as Record<string, unknown>;
  if (typeof response.access_token !== "string") {
    const description =
      typeof response.error_description === "string"
        ? response.error_description
        : "Yahoo OAuth did not issue an access token";
    throw new YahooError("authentication", description);
  }
  return response as YahooTokenResponse;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new YahooError(
      "authentication",
      "Yahoo OAuth returned malformed JSON",
      { status: response.status },
    );
  }
}

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function buildAuthorizationUrl(
  config: YahooConfig,
  state: string,
  scopes: readonly string[] = config.scopes,
): string {
  required(state, "state");
  const url = new URL("/oauth2/request_auth", config.oauthBaseUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  if (scopes.length > 0) url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

/** Yahoo auth-code flow with OOB support and refresh-token rotation. */
export class YahooOAuth {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private refreshInFlight: Promise<YahooToken> | undefined;

  public constructor(
    private readonly config: YahooConfig,
    private readonly store: SecureTokenStore = new SecureTokenStore(
      config.tokenPath,
    ),
    options: OAuthExchangeOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  public authorizationUrl(
    state = createOAuthState(),
    scopes = this.config.scopes,
  ): string {
    return buildAuthorizationUrl(this.config, state, scopes);
  }

  public async exchangeCode(code: string): Promise<YahooToken> {
    return this.exchange({
      grant_type: "authorization_code",
      code: required(code, "code"),
      redirect_uri: this.config.redirectUri,
    });
  }

  public async refresh(refreshToken?: string): Promise<YahooToken> {
    const existing = refreshToken ?? (await this.store.read())?.refreshToken;
    const refreshValue = required(existing ?? "", "refresh token");
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.exchange({
      grant_type: "refresh_token",
      redirect_uri: this.config.redirectUri,
      refresh_token: refreshValue,
    })
      .then(async (token) => {
        if (!token.refreshToken) token.refreshToken = refreshValue;
        await this.store.write(token);
        return token;
      })
      .finally(() => {
        this.refreshInFlight = undefined;
      });
    return this.refreshInFlight;
  }

  public async authenticate(code: string): Promise<YahooToken> {
    const token = await this.exchangeCode(code);
    await this.store.write(token);
    return token;
  }

  public async readToken(): Promise<YahooToken | null> {
    return this.store.read();
  }

  public async clear(): Promise<void> {
    await this.store.clear();
  }

  /** Return a token with at least a one-minute validity window. */
  public async validToken(): Promise<YahooToken> {
    const token = await this.store.read();
    if (!token)
      throw new YahooError(
        "authentication",
        "Yahoo account is not authenticated; run the auth command first",
      );
    if (token.expiresAt === undefined || token.expiresAt - this.now() > 60_000)
      return token;
    if (!token.refreshToken)
      throw new YahooError(
        "authentication",
        "Yahoo access token expired and no refresh token is available",
      );
    return this.refresh(token.refreshToken);
  }

  private async exchange(
    parameters: Record<string, string>,
  ): Promise<YahooToken> {
    const url = new URL("/oauth2/get_token", this.config.oauthBaseUrl);
    const body = new URLSearchParams(parameters);
    const clientCredentials = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
      "utf8",
    ).toString("base64");
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Basic ${clientCredentials}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      });
    } catch (error) {
      throw new YahooError("network", "Unable to reach Yahoo OAuth", {
        cause: error,
      });
    }
    let parsed: unknown;
    try {
      parsed = await readJsonResponse(response);
    } catch (error) {
      if (error instanceof YahooError) throw error;
      throw new YahooError(
        "authentication",
        "Unable to read Yahoo OAuth response",
        { cause: error, status: response.status },
      );
    }
    if (!response.ok) {
      const value =
        parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)
          : {};
      const description =
        typeof value.error_description === "string"
          ? value.error_description
          : typeof value.error === "string"
            ? value.error
            : `Yahoo OAuth failed (${response.status})`;
      throw new YahooError("authentication", description, {
        status: response.status,
      });
    }
    return tokenFromResponse(asOAuthResponse(parsed), this.now());
  }
}
