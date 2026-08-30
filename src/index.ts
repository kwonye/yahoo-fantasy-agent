import { serveStdio } from "@modelcontextprotocol/server/stdio";
import packageJson from "../package.json" with { type: "json" };
import { inspectConfig, loadConfig, type YahooConfigStatus } from "./config.js";
import { errorPayload } from "./mcp/helpers.js";
import { createMcpServer } from "./mcp/server.js";
import type { McpRuntime, YahooApi } from "./mcp/types.js";
import { YahooClient } from "./yahoo/client.js";
import { asYahooError, YahooError } from "./yahoo/errors.js";
import { YahooOAuth } from "./yahoo/oauth.js";
import { SecureTokenStore } from "./yahoo/token-store.js";

export { createMcpServer } from "./mcp/server.js";
export type { McpRuntime, YahooApi } from "./mcp/types.js";
export * from "./yahoo/index.js";
export { isLoopbackHost, loadHttpConfig } from "./config.js";
export type {
  HttpConfig,
  HttpConfigOverrides,
  HttpResponseMode,
} from "./config.js";
export {
  createYahooFantasyHttpHandler,
  serveYahooFantasyHttp,
} from "./http.js";
export type {
  YahooHttpHandlerOptions,
  YahooHttpServerHandle,
  YahooHttpServerOptions,
} from "./http.js";

function unavailableYahooApi(error: YahooError): YahooApi {
  const fail = (): Promise<never> => Promise.reject(error);
  return { get: fail, post: fail, put: fail, delete: fail };
}

function reportStartupIssue(error: unknown): void {
  const details = errorPayload(error);
  console.error(
    `[yahoo-fantasy-mcp] ${String(details.code)}: ${String(details.message)}\nAction: ${String(details.action)}`,
  );
}

async function readTokenState(store: SecureTokenStore): Promise<{
  token: Awaited<ReturnType<SecureTokenStore["read"]>>;
  error?: unknown;
}> {
  try {
    return { token: await store.read() };
  } catch (error) {
    return { token: null, error };
  }
}

function degradedRuntime(
  error: unknown,
  status: YahooConfigStatus = inspectConfig(),
): McpRuntime {
  const configurationError = asYahooError(error, "configuration");
  const failure = errorPayload(configurationError);
  const store = new SecureTokenStore(status.tokenPath);
  const configuration = {
    configured: false,
    missing: status.missing,
    ...(status.error === undefined ? {} : { error: status.error }),
  };

  const diagnostic = async (): Promise<Record<string, unknown>> => {
    const tokenState = await readTokenState(store);
    return {
      ready: false,
      configuration,
      token: {
        present: tokenState.token !== null,
        tokenPath: status.tokenPath,
        ...(tokenState.error === undefined
          ? {}
          : { error: errorPayload(tokenState.error) }),
      },
      api: {
        reachable: false,
        skipped: true,
        reason: "Fix Yahoo configuration before checking API reachability",
        error: failure,
      },
      nextAction: failure.action,
    };
  };

  const fail = (): Promise<never> => Promise.reject(configurationError);

  return {
    yahoo: unavailableYahooApi(configurationError),
    auth: {
      authorize: fail,
      authenticate: fail,
      status: async () => {
        const tokenState = await readTokenState(store);
        return {
          configured: false,
          authenticated: tokenState.token !== null,
          tokenPath: status.tokenPath,
          configuration,
          ...(tokenState.error === undefined
            ? {}
            : { error: errorPayload(tokenState.error) }),
          nextAction: failure.action,
        };
      },
      logout: () => store.clear(),
    },
    doctor: diagnostic,
  };
}

/**
 * Run the server over stdio. The factory creates a fresh MCP instance for the
 * connection as required by the v2 SDK; no application logs are written to
 * stdout while this function is serving protocol messages.
 */
export function serveYahooFantasy(
  runtime: McpRuntime,
  options: { name?: string; version?: string } = {},
): { close(): Promise<void> } {
  const serverOptions =
    options.name === undefined
      ? { version: options.version ?? packageJson.version }
      : { name: options.name, version: options.version ?? packageJson.version };
  return serveStdio(() => createMcpServer(runtime, serverOptions), {
    onerror: (error) => console.error(`[yahoo-fantasy-mcp] ${error.message}`),
  });
}

export function loadDefaultRuntime(): Promise<McpRuntime> {
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const configurationError = new YahooError(
        "configuration",
        `Unable to load the .env file: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
      reportStartupIssue(configurationError);
      return Promise.resolve(degradedRuntime(configurationError));
    }
  }
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    const configurationError = asYahooError(error, "configuration");
    reportStartupIssue(configurationError);
    return Promise.resolve(degradedRuntime(configurationError));
  }
  const store = new SecureTokenStore(config.tokenPath);
  const oauth = new YahooOAuth(config, store);
  const yahoo = new YahooClient(config, oauth);
  return Promise.resolve({
    yahoo,
    auth: {
      authorize: () => oauth.authorizationUrl(),
      authenticate: (code: string) => oauth.authenticate(code),
      status: async () => {
        const token = await oauth.readToken();
        if (!token)
          return { authenticated: false, tokenPath: config.tokenPath };
        return {
          authenticated: true,
          tokenPath: config.tokenPath,
          expiresAt: token.expiresAt,
          scope: token.scope,
          tokenType: token.tokenType,
        };
      },
      logout: () => oauth.clear(),
    },
    doctor: async () => {
      const tokenState = await readTokenState(store);
      const base = {
        config: {
          apiBaseUrl: config.apiBaseUrl,
          oauthBaseUrl: config.oauthBaseUrl,
          redirectUri: config.redirectUri,
          scopes: config.scopes,
        },
        configuration: { configured: true, missing: [] as readonly string[] },
      };
      if (tokenState.error !== undefined) {
        const error = errorPayload(tokenState.error);
        return {
          ...base,
          ready: false,
          token: {
            present: false,
            error,
          },
          api: {
            reachable: false,
            skipped: true,
            reason:
              "Repair the Yahoo token store before checking API reachability",
            error,
          },
          nextAction: error.action,
        };
      }
      const token = tokenState.token;
      if (!token) {
        return {
          ...base,
          ready: false,
          token: { present: false },
          api: {
            reachable: false,
            skipped: true,
            reason: "Authenticate before checking Yahoo API reachability",
          },
          nextAction:
            "Run `yahoo-fantasy-mcp auth` to authenticate, then retry the request.",
        };
      }
      let api: Record<string, unknown>;
      try {
        const response = await yahoo.get("users;use_login=1/games");
        api = { reachable: true, status: response.status };
      } catch (error) {
        const details = errorPayload(error);
        api = { reachable: false, error: details };
        return {
          ...base,
          ready: false,
          token: {
            present: true,
            expiresAt: token.expiresAt,
            scope: token.scope,
          },
          api,
          nextAction: details.action,
        };
      }
      return {
        ...base,
        ready: true,
        token: {
          present: true,
          expiresAt: token.expiresAt,
          scope: token.scope,
        },
        api,
        nextAction:
          "Yahoo configuration, authentication, and API reachability look healthy.",
      };
    },
  });
}
