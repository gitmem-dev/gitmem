/**
 * OAuth 2.1 resource-server pieces for the HTTP transport (GIT-130, Phase 2).
 *
 * Ruling 2026-10-18: Supabase Auth is the authorization server. GitMem is the
 * protected resource. The customer's own Supabase project issues the tokens,
 * so one GitMem deployment serves one Supabase project.
 *
 * Two things a remote MCP client (claude.ai custom connector, Claude mobile)
 * needs from the resource server, per the MCP authorization spec / RFC 9728:
 *
 *   1. `/.well-known/oauth-protected-resource` — tells the client which
 *      authorization server to go to. Also referenced from the
 *      `WWW-Authenticate` header on 401 so the client can discover it.
 *   2. Access-token validation on every request: Supabase-issued JWT,
 *      verified against the project's JWKS (asymmetric signing keys) or,
 *      for projects still on the legacy shared secret, HS256.
 *
 * Supabase values (https://supabase.com/docs/guides/auth/oauth-server):
 *   issuer   https://<ref>.supabase.co/auth/v1
 *   JWKS     <issuer>/.well-known/jwks.json
 *   AS meta  https://<ref>.supabase.co/.well-known/oauth-authorization-server/auth/v1
 *
 * Not in this module (deferred, see GIT-130): per-user Supabase client so
 * RLS applies as the signed-in user. GitMem reaches Supabase with a
 * module-level service key via fetch in several services; threading a user
 * token through is a cross-cutting change. Until then a valid token from the
 * project's own auth server gates access, and writes run as the service role.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey, KeyObject } from "jose";

export interface OAuthConfig {
  /** Authorization server issuer, e.g. https://<ref>.supabase.co/auth/v1 */
  issuer: string;
  /** Expected `aud`. Supabase user tokens carry "authenticated". */
  audience: string;
  /** Public base URL of this GitMem deployment, e.g. https://mem.example.com */
  publicUrl: string;
  /** MCP path, default /mcp */
  mcpPath: string;
  /** Override JWKS URL (default `${issuer}/.well-known/jwks.json`). */
  jwksUrl?: string;
  /** Legacy HS256 shared secret for projects without asymmetric signing keys. */
  hmacSecret?: string;
}

export interface VerifiedToken {
  subject: string;
  clientId?: string;
  scope?: string;
  claims: JWTPayload;
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/** RFC 9728 metadata document for `/.well-known/oauth-protected-resource`. */
export function protectedResourceMetadata(cfg: OAuthConfig): Record<string, unknown> {
  const base = trimSlash(cfg.publicUrl);
  return {
    resource: `${base}${cfg.mcpPath}`,
    authorization_servers: [trimSlash(cfg.issuer)],
    bearer_methods_supported: ["header"],
    resource_name: "GitMem",
    resource_documentation: "https://gitmem.ai/docs",
  };
}

/** Value for `WWW-Authenticate` on 401 so clients can find the metadata. */
export function wwwAuthenticateChallenge(cfg: OAuthConfig, error?: string): string {
  const base = trimSlash(cfg.publicUrl);
  const parts = [`Bearer realm="gitmem"`, `resource_metadata="${base}/.well-known/oauth-protected-resource"`];
  if (error) parts.push(`error="${error}"`);
  return parts.join(", ");
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedToken | null>;
}

/**
 * Build a verifier. JWKS is fetched lazily and cached by jose; a key rotation
 * triggers a refetch automatically.
 */
export function createTokenVerifier(cfg: OAuthConfig): TokenVerifier {
  const issuer = trimSlash(cfg.issuer);
  let keySource: JWTVerifyGetKey | KeyObject | Uint8Array;

  if (cfg.hmacSecret) {
    keySource = new TextEncoder().encode(cfg.hmacSecret);
  } else {
    const jwks = new URL(cfg.jwksUrl ?? `${issuer}/.well-known/jwks.json`);
    keySource = createRemoteJWKSet(jwks);
  }

  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, keySource as JWTVerifyGetKey, {
          issuer,
          audience: cfg.audience,
        });
        if (!payload.sub) return null;
        return {
          subject: payload.sub,
          clientId: typeof payload.client_id === "string" ? payload.client_id : undefined,
          scope: typeof payload.scope === "string" ? payload.scope : undefined,
          claims: payload,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[gitmem:oauth] token rejected: ${message}`);
        return null;
      }
    },
  };
}

/** Read OAuth config from the environment; undefined when OAuth mode is off. */
export function oauthConfigFromEnv(env: NodeJS.ProcessEnv, mcpPath: string): OAuthConfig | undefined {
  const issuer = env.GITMEM_OAUTH_ISSUER?.trim();
  if (!issuer) return undefined;
  const publicUrl = env.GITMEM_PUBLIC_URL?.trim();
  if (!publicUrl) {
    throw new Error("GITMEM_PUBLIC_URL is required when GITMEM_OAUTH_ISSUER is set (the URL clients reach this server at).");
  }
  return {
    issuer,
    audience: env.GITMEM_OAUTH_AUDIENCE?.trim() || "authenticated",
    publicUrl,
    mcpPath,
    jwksUrl: env.GITMEM_OAUTH_JWKS_URL?.trim() || undefined,
    hmacSecret: env.GITMEM_OAUTH_JWT_SECRET?.trim() || undefined,
  };
}
