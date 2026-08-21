import type { McpServer } from "@modelcontextprotocol/server";
import type { YahooRequestOptions, YahooResponse } from "../yahoo/client.js";

export interface YahooApi {
  get(path: string, options?: YahooRequestOptions): Promise<YahooResponse>;
  post(
    path: string,
    body: string,
    options?: YahooRequestOptions,
  ): Promise<YahooResponse>;
  put(
    path: string,
    body: string,
    options?: YahooRequestOptions,
  ): Promise<YahooResponse>;
  delete(path: string, options?: YahooRequestOptions): Promise<YahooResponse>;
}

export interface McpRuntime {
  yahoo: YahooApi;
  doctor?: () => unknown;
  auth?: {
    authorize?: () => unknown;
    authenticate?: (code: string) => unknown;
    status?: () => unknown;
    logout?: () => unknown;
  };
}

export type CreateMcpServer = (runtime: McpRuntime) => McpServer;
