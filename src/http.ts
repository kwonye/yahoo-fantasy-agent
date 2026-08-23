import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  createMcpHandler,
  type AuthInfo,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import packageJson from "../package.json" with { type: "json" };
import {
  loadHttpConfig,
  isLoopbackHost,
  type HttpConfig,
  type HttpConfigOverrides,
  type HttpResponseMode,
} from "./config.js";
import { createMcpServer } from "./mcp/server.js";
import type { McpRuntime } from "./mcp/types.js";

export interface YahooHttpHandlerOptions {
  responseMode?: HttpResponseMode;
  name?: string;
  version?: string;
}

export interface YahooHttpServerOptions extends YahooHttpHandlerOptions {
  config?: HttpConfig;
  environment?: Parameters<typeof loadHttpConfig>[0];
  overrides?: HttpConfigOverrides;
}

export interface YahooHttpServerHandle {
  readonly url: URL;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

type AuthorizedRequest = IncomingMessage & { auth?: AuthInfo };

function serverOptions(options: YahooHttpHandlerOptions): {
  name: string;
  version: string;
} {
  return {
    name: options.name ?? "yahoo-fantasy-mcp",
    version: options.version ?? packageJson.version,
  };
}

/**
 * Build a web-standard MCP v2 handler. The SDK creates a fresh server instance
 * for every request, while this runtime remains shared for Yahoo token/cache
 * access. `legacy: stateless` keeps 2025 clients working without reviving the
 * deprecated HTTP+SSE server transport.
 */
export function createYahooFantasyHttpHandler(
  runtime: McpRuntime,
  options: YahooHttpHandlerOptions = {},
): McpHttpHandler {
  const identity = serverOptions(options);
  return createMcpHandler(() => createMcpServer(runtime, identity), {
    legacy: "stateless",
    responseMode: options.responseMode ?? "auto",
    onerror: (error) => console.error(`[yahoo-fantasy-mcp] ${error.message}`),
  });
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function routePath(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return "";
  }
}

function sameSecret(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return (
    expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes)
  );
}

function authorize(
  request: AuthorizedRequest,
  response: ServerResponse,
  token: string | undefined,
): boolean {
  if (token === undefined) return true;
  const authorization = request.headers.authorization;
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1] || !sameSecret(token, match[1].trim())) {
    writeJson(
      response,
      401,
      { error: "Unauthorized" },
      { "www-authenticate": 'Bearer realm="yahoo-fantasy-mcp"' },
    );
    return false;
  }
  request.auth = {
    token: match[1].trim(),
    clientId: "static-bearer-token",
    scopes: [],
  };
  return true;
}

function listen(
  server: ReturnType<typeof createServer>,
  config: HttpConfig,
): Promise<{ host: string; port: number }> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("MCP HTTP server did not expose a TCP address"));
        return;
      }
      resolve({ host: config.host, port: address.port });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.host);
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function urlFor(config: HttpConfig, port: number): URL {
  const hostname = config.host.includes(":")
    ? `[${config.host.replace(/^\[|\]$/g, "")}]`
    : config.host;
  return new URL(`http://${hostname}:${port}${config.path}`);
}

/** Start the Node.js MCP v2 Streamable HTTP server. */
export async function serveYahooFantasyHttp(
  runtime: McpRuntime,
  options: YahooHttpServerOptions = {},
): Promise<YahooHttpServerHandle> {
  const config =
    options.config === undefined
      ? loadHttpConfig(options.environment, options.overrides)
      : loadHttpConfig({}, options.config);
  const handler = createYahooFantasyHttpHandler(runtime, {
    responseMode: options.responseMode ?? config.responseMode,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.version === undefined ? {} : { version: options.version }),
  });
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => console.error(`[yahoo-fantasy-mcp] ${error.message}`),
  });
  const validateHost = isLoopbackHost(config.host)
    ? localhostHostValidation()
    : hostHeaderValidation([...config.allowedHosts]);
  const validateOrigin = isLoopbackHost(config.host)
    ? localhostOriginValidation()
    : originValidation([...config.allowedOrigins]);
  const server = createServer((request, response) => {
    if (routePath(request) !== config.path) {
      writeJson(response, 404, { error: "Not found" });
      return;
    }
    if (!validateHost(request, response) || !validateOrigin(request, response))
      return;
    if (!authorize(request, response, config.token)) return;
    const nodeRequest = request as unknown as Parameters<typeof nodeHandler>[0];
    const nodeResponse = response as unknown as Parameters<
      typeof nodeHandler
    >[1];
    void nodeHandler(nodeRequest, nodeResponse).catch((error: unknown) => {
      console.error(
        `[yahoo-fantasy-mcp] ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!response.headersSent)
        writeJson(response, 500, { error: "Internal server error" });
      else response.destroy();
    });
  });
  const listening = await listen(server, config);
  const url = urlFor(config, listening.port);
  let closePromise: Promise<void> | undefined;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  const close = async (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      try {
        await handler.close();
        await closeServer(server);
        resolveClosed();
      } catch (error) {
        rejectClosed(error);
        throw error;
      }
    })();
    return closePromise;
  };
  return { url, closed, close };
}
