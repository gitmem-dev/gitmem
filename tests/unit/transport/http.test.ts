/**
 * GIT-130 Phase 1: Streamable HTTP transport wire test.
 *
 * Proves the same tool surface stdio clients get is reachable over HTTP,
 * that the bearer gate holds, and that the server refuses to start without
 * a usable token. Uses the MCP SDK's own HTTP client, so a pass here means a
 * real MCP client (Claude Code `--transport http`, a claude.ai connector once
 * OAuth lands) can talk to it.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer } from "../../../src/transport/http.js";
import type { RunningHttpServer } from "../../../src/transport/http.js";
import { createServer } from "../../../src/server.js";

const TOKEN = "test-token-0123456789abcdefghijklmnop"; // >= 24 chars

describe("Streamable HTTP transport", () => {
  let running: RunningHttpServer;
  let base: string;

  beforeAll(async () => {
    running = await startHttpServer({ createServer, token: TOKEN, port: 0 });
    base = `http://${running.host}:${running.port}`;
  });

  afterAll(async () => {
    await running.close();
  });

  it("refuses to start without a token of usable length", async () => {
    await expect(startHttpServer({ createServer, token: undefined, port: 0 })).rejects.toThrow(/GITMEM_HTTP_TOKEN/);
    await expect(startHttpServer({ createServer, token: "short", port: 0 })).rejects.toThrow(/GITMEM_HTTP_TOKEN/);
  });

  it("answers /healthz without auth", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, transport: "streamable-http", auth: "bearer" });
  });

  it("returns 401 with WWW-Authenticate when the bearer is missing or wrong", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

    const noAuth = await fetch(`${base}${running.path}`, { method: "POST", headers, body });
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get("www-authenticate")).toMatch(/Bearer/);

    const wrong = await fetch(`${base}${running.path}`, {
      method: "POST",
      headers: { ...headers, authorization: "Bearer not-the-token-not-the-token-xx" },
      body,
    });
    expect(wrong.status).toBe(401);
  });

  it("404s paths other than the MCP path", async () => {
    const res = await fetch(`${base}/somewhere-else`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
  });

  it("serves the full tool surface to an SDK client with the right bearer", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}${running.path}`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client({ name: "gitmem-http-test", version: "0.0.0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("recall");
    expect(names).toContain("session_start");
    expect(names).toContain("session_close");
    expect(names).toContain("confirm_scars");
    expect(names).toContain("create_learning");

    const help = await client.callTool({ name: "gitmem-help", arguments: {} });
    const text = (help.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? "")
      .join("\n");
    expect(text.length).toBeGreaterThan(0);

    await client.close();
  });
});
