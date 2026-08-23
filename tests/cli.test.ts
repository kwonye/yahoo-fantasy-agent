import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import type { McpRuntime } from "../src/mcp/types.js";

function outputBuffer(): { stream: NodeJS.WritableStream; read(): string } {
  let value = "";
  return {
    stream: {
      write(chunk: string | Uint8Array): boolean {
        value +=
          typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        return true;
      },
    } as NodeJS.WritableStream,
    read: () => value,
  };
}

const runtime: McpRuntime = {
  yahoo: {
    get: () => Promise.resolve({ status: 200, data: {} }),
    post: () => Promise.resolve({ status: 200, data: {} }),
    put: () => Promise.resolve({ status: 200, data: {} }),
    delete: () => Promise.resolve({ status: 200, data: {} }),
  },
};

describe("CLI transport selection", () => {
  it("documents stdio and HTTP usage in help", async () => {
    const captured = outputBuffer();
    await runCli(["--help"], { output: captured.stream });
    expect(captured.read()).toContain("--transport http");
    expect(captured.read()).toContain("Without a command");
  });

  it("rejects HTTP-only flags on stdio", async () => {
    await expect(
      runCli(["serve", "--port", "3000"], {
        loadRuntime: () => Promise.resolve(runtime),
      }),
    ).rejects.toThrow("require --transport http");
  });

  it("passes validated HTTP options to the HTTP server dependency", async () => {
    let received: { host: string; port: number; path: string } | undefined;
    await runCli(["serve", "--transport", "http", "--port", "0"], {
      loadRuntime: () => Promise.resolve(runtime),
      serveHttp: (_value, config) => {
        received = { host: config.host, port: config.port, path: config.path };
        return Promise.resolve({
          url: new URL("http://127.0.0.1:3000/mcp"),
          closed: Promise.resolve(),
          close: () => Promise.resolve(),
        });
      },
    });
    expect(received).toEqual({ host: "127.0.0.1", port: 0, path: "/mcp" });
  });
});
