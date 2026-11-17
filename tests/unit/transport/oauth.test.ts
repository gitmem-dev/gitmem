/**
 * GIT-130 Phase 2: OAuth 2.1 resource-server test.
 *
 * Stands in for Supabase Auth with a local JWKS endpoint and an ES256
 * keypair, then proves the HTTP transport: publishes RFC 9728 metadata,
 * challenges with resource_metadata on 401, accepts a correctly issued
 * JWT, and rejects wrong issuer / wrong audience / expired / bad key.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer as createNodeServer } from "node:http";
import type { Server as NodeServer } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import type { KeyLike } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer } from "../../../src/transport/http.js";
import type { RunningHttpServer } from "../../../src/transport/http.js";
import { createServer } from "../../../src/server.js";

const AUDIENCE = "authenticated";

let jwksServer: NodeServer;
let issuer: string;
let privateKey: KeyLike;
let otherPrivateKey: KeyLike;
let running: RunningHttpServer;
let base: string;

async function sign(
  key: KeyLike,
  overrides: { iss?: string; aud?: string; exp?: string; sub?: string } = {}
): Promise<string> {
  return new SignJWT({ client_id: "test-client", scope: "mcp" })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setIssuer(overrides.iss ?? issuer)
    .setAudience(overrides.aud ?? AUDIENCE)
    .setSubject(overrides.sub ?? "user-123")
    .setIssuedAt()
    .setExpirationTime(overrides.exp ?? "5m")
    .sign(key);
}

async function postMcp(token?: string) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}${running.path}`, { method: "POST", headers, body });
}

describe("OAuth 2.1 resource server (Supabase Auth as AS)", () => {
  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    otherPrivateKey = (await generateKeyPair("ES256")).privateKey;
    const jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "ES256", use: "sig" };

    // Fake Supabase Auth: only the JWKS endpoint matters to the resource server.
    jwksServer = createNodeServer((req, res) => {
      if (req.url === "/auth/v1/.well-known/jwks.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: [jwk] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => jwksServer.listen(0, "127.0.0.1", r));
    const a = jwksServer.address();
    const jwksPort = typeof a === "object" && a ? a.port : 0;
    issuer = `http://127.0.0.1:${jwksPort}/auth/v1`;

    running = await startHttpServer({
      createServer,
      port: 0,
      auth: {
        mode: "oauth",
        config: {
          issuer,
          audience: AUDIENCE,
          publicUrl: "https://mem.example.test",
          mcpPath: "/mcp",
        },
      },
    });
    base = `http://${running.host}:${running.port}`;
  });

  afterAll(async () => {
    await running.close();
    await new Promise<void>((r) => jwksServer.close(() => r()));
  });

  it("refuses OAuth mode without a public URL", async () => {
    const { oauthConfigFromEnv } = await import("../../../src/transport/oauth.js");
    expect(() => oauthConfigFromEnv({ GITMEM_OAUTH_ISSUER: issuer } as NodeJS.ProcessEnv, "/mcp")).toThrow(/GITMEM_PUBLIC_URL/);
    expect(oauthConfigFromEnv({} as NodeJS.ProcessEnv, "/mcp")).toBeUndefined();
  });

  it("publishes RFC 9728 protected-resource metadata without auth", async () => {
    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(200);
      const meta = await res.json();
      expect(meta.resource).toBe("https://mem.example.test/mcp");
      expect(meta.authorization_servers).toEqual([issuer]);
      expect(meta.bearer_methods_supported).toEqual(["header"]);
    }
  });

  it("challenges with resource_metadata on a missing token", async () => {
    const res = await postMcp();
    expect(res.status).toBe(401);
    const www = res.headers.get("www-authenticate") ?? "";
    expect(www).toMatch(/^Bearer /);
    expect(www).toContain('resource_metadata="https://mem.example.test/.well-known/oauth-protected-resource"');
  });

  it("rejects wrong issuer, wrong audience, expired, and wrong key", async () => {
    expect((await postMcp(await sign(privateKey, { iss: "http://evil.test/auth/v1" }))).status).toBe(401);
    expect((await postMcp(await sign(privateKey, { aud: "someone-else" }))).status).toBe(401);
    expect((await postMcp(await sign(privateKey, { exp: "-1m" }))).status).toBe(401);
    expect((await postMcp(await sign(otherPrivateKey))).status).toBe(401);
    expect((await postMcp("not.a.jwt")).status).toBe(401);
  });

  it("accepts a token issued by the authorization server and serves tools", async () => {
    const token = await sign(privateKey);
    const transport = new StreamableHTTPClientTransport(new URL(`${base}${running.path}`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "gitmem-oauth-test", version: "0.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("recall");
    await client.close();
  });

  it("healthz reports oauth mode", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(await res.json()).toEqual({ ok: true, transport: "streamable-http", auth: "oauth" });
  });
});
