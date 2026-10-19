/**
 * Streamable HTTP transport for GitMem (GIT-130, Phase 1).
 *
 * Lets surfaces that cannot spawn a process — Claude mobile, claude.ai web,
 * Claude Code cloud sessions, Cowork — reach the same tool surface that stdio
 * clients get. The server is created exactly as for stdio (createServer());
 * only the wire changes.
 *
 * Phase 1 scope, deliberately narrow:
 *   - One deployment serves one GitMem install (one Supabase project, one
 *     user). Session state in services/session-state.ts is process-global,
 *     so this is NOT multi-tenant. Multi-user is GIT-130's deep-dive item.
 *   - Auth is a static bearer token (GITMEM_HTTP_TOKEN). OAuth 2.1 for the
 *     claude.ai custom-connector flow is the remaining GIT-130 research item;
 *     bearer is enough for `claude mcp add --transport http --header ...`.
 *   - Stateless MCP mode: a fresh Server + transport per request, no MCP
 *     session id. Correct for the SDK's stateless pattern and avoids holding
 *     per-connection objects across a mobile client's reconnects.
 *
 * Logging goes to stderr only (recurring scar: stdout belongs to the stdio
 * protocol; keep the discipline so one binary serves both transports).
 */

import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server as NodeHttpServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import {
  createTokenVerifier,
  protectedResourceMetadata,
  wwwAuthenticateChallenge,
} from "./oauth.js";
import type { OAuthConfig, TokenVerifier } from "./oauth.js";

export type HttpAuth =
  /** Static shared secret. Dev, CI, and Claude Code `--header` use. */
  | { mode: "bearer"; token: string | undefined }
  /** OAuth 2.1 resource server; Supabase Auth is the authorization server. */
  | { mode: "oauth"; config: OAuthConfig };

export interface HttpServerOptions {
  /** Factory for a configured MCP server; called once per request (stateless mode). */
  createServer: () => McpServer;
  /** How clients authenticate. `token` (below) is shorthand for bearer mode. */
  auth?: HttpAuth;
  /** Bearer token clients must present. Shorthand for `auth: { mode: "bearer", token }`. */
  token?: string | undefined;
  /** Port to listen on. 0 picks a free port (tests). */
  port: number;
  /** Interface to bind. Default 127.0.0.1; set 0.0.0.0 behind a reverse proxy. */
  host?: string;
  /** Path that serves MCP. Default /mcp. */
  path?: string;
}

export interface RunningHttpServer {
  port: number;
  host: string;
  path: string;
  authMode: "bearer" | "oauth";
  close: () => Promise<void>;
}

const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

const MIN_TOKEN_LENGTH = 24;

function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerFrom(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, value] = header.split(" ", 2);
  if (!scheme || scheme.toLowerCase() !== "bearer") return undefined;
  return value?.trim();
}

function json(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(body));
}

/**
 * Start the HTTP transport. Resolves once listening.
 */
export async function startHttpServer(opts: HttpServerOptions): Promise<RunningHttpServer> {
  const host = opts.host ?? "127.0.0.1";
  const path = opts.path ?? "/mcp";
  const auth: HttpAuth = opts.auth ?? { mode: "bearer", token: opts.token };

  // Resolve the authenticator once, up front, so misconfiguration fails at start.
  let authenticate: (req: IncomingMessage) => Promise<boolean>;
  let challenge: string;

  if (auth.mode === "bearer") {
    const token = auth.token?.trim();
    if (!token || token.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `GITMEM_HTTP_TOKEN must be set to at least ${MIN_TOKEN_LENGTH} characters to run the HTTP transport ` +
          `(or set GITMEM_OAUTH_ISSUER for OAuth mode). Generate one with: openssl rand -base64 32`
      );
    }
    challenge = 'Bearer realm="gitmem"';
    authenticate = async (req) => tokenMatches(bearerFrom(req), token);
  } else {
    const cfg: OAuthConfig = { ...auth.config, mcpPath: auth.config.mcpPath || path };
    const verifier: TokenVerifier = createTokenVerifier(cfg);
    challenge = wwwAuthenticateChallenge(cfg);
    authenticate = async (req) => {
      const presented = bearerFrom(req);
      if (!presented) return false;
      return (await verifier.verify(presented)) !== null;
    };
  }

  const httpServer: NodeHttpServer = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      // Unauthenticated liveness probe for load balancers / uptime checks.
      if (url.pathname === "/healthz" && req.method === "GET") {
        json(res, 200, { ok: true, transport: "streamable-http", auth: auth.mode });
        return;
      }

      // RFC 9728: unauthenticated discovery document (OAuth mode only).
      if (auth.mode === "oauth" && req.method === "GET" &&
          (url.pathname === PROTECTED_RESOURCE_PATH || url.pathname === `${PROTECTED_RESOURCE_PATH}${path}`)) {
        json(res, 200, protectedResourceMetadata({ ...auth.config, mcpPath: auth.config.mcpPath || path }));
        return;
      }

      if (url.pathname !== path) {
        json(res, 404, { error: "not found" });
        return;
      }

      if (!(await authenticate(req))) {
        json(res, 401, { error: "unauthorized" }, { "www-authenticate": challenge });
        return;
      }

      if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
        json(res, 405, { error: "method not allowed" }, { allow: "POST, GET, DELETE" });
        return;
      }

      // Stateless: new server + transport per request.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const mcp = opts.createServer();
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[gitmem:http] request error: ${message}`);
      if (!res.headersSent) {
        json(res, 500, { error: "internal error" });
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : opts.port;

  console.error(`[gitmem:http] listening on http://${host}:${port}${path} | auth: ${auth.mode}`);

  return {
    port,
    host,
    path,
    authMode: auth.mode,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
