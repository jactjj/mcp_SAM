import type { Context, Hono } from "hono";
import type { AccountConfig, Config } from "../config.js";
import type { Logger } from "../logger.js";
import { type TokenSigner, type UsedTokenRegistry, safeEqual, sha256Base64Url } from "../security/signer.js";
import { consentPage, errorPage } from "./page.js";

export const ACCESS_TOKEN_TTL = 3600;
export const REFRESH_TOKEN_TTL = 30 * 24 * 3600;
const CODE_TTL = 120;
const AUTH_REQUEST_TTL = 600;
export const SCOPE = "sam";

const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60_000;

type AuthMethod = "none" | "client_secret_post" | "client_secret_basic";

interface ClientClaims {
  redirect_uris: string[];
  client_name: string;
  auth_method: AuthMethod;
}

interface CodeClaims {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  sub: string;
  jti?: string;
  exp?: number;
}

interface AuthRequestClaims {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state?: string;
  scope: string;
}

interface RefreshClaims {
  client_id: string;
  sub: string;
  scope: string;
}

export interface OAuthDeps {
  config: Config;
  signer: TokenSigner;
  usedCodes: UsedTokenRegistry;
  logger: Logger;
}

export function publicBaseUrl(config: Config, c: Context): string {
  if (config.auth.publicUrl) return config.auth.publicUrl;
  const url = new URL(c.req.url);
  return url.origin;
}

/** Only redirect URIs on allowed hosts (claude.ai by default), over https except on localhost. */
export function isAllowedRedirectUri(uri: string, allowedHosts: string[]): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  const host = u.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return false;
  return allowedHosts.includes(host);
}

class FailureTracker {
  private failures: number[] = [];
  locked(now = Date.now()): boolean {
    this.failures = this.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    return this.failures.length >= MAX_FAILURES;
  }
  record(now = Date.now()): void {
    this.failures.push(now);
  }
  reset(): void {
    this.failures = [];
  }
}

function oauthError(c: Context, status: 400 | 401, error: string, description: string): Response {
  return c.json({ error, error_description: description }, status, { "Cache-Control": "no-store" });
}

function htmlHeaders(redirectOrigin?: string): Record<string, string> {
  const formAction = ["'self'", redirectOrigin].filter(Boolean).join(" ");
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
  };
}

function redirectWith(uri: string, params: Record<string, string | undefined>): Response {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: u.toString(), "Cache-Control": "no-store" } });
}

async function readForm(c: Context): Promise<Record<string, string>> {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  }
  const body = await c.req.parseBody().catch(() => ({}));
  return Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === "string")) as Record<string, string>;
}

/**
 * Minimal OAuth 2.1 authorization server for a single owner, compatible with the
 * Claude.ai custom connector flow (metadata discovery, dynamic client registration,
 * authorization code + PKCE S256, refresh tokens).
 *
 * Everything is stateless: client ids, codes and tokens are signed JWTs.
 * The owner proves identity with MCP_OWNER_PASSWORD on the consent page;
 * this is independent from the SAM credentials, which never leave the server.
 */
export function registerOAuthRoutes(app: Hono, deps: OAuthDeps): void {
  const { config, signer, usedCodes, logger } = deps;
  const failures = new FailureTracker();

  const verifyClient = async (clientId: string | undefined) =>
    clientId ? signer.verify<ClientClaims & { sub?: string }>("client", clientId) : undefined;

  const protectedResource = (c: Context) => {
    const base = publicBaseUrl(config, c);
    return c.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      scopes_supported: [SCOPE],
      resource_name: "SAM CRM (MCP)",
    });
  };
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  const authServerMetadata = (c: Context) => {
    const base = publicBaseUrl(config, c);
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: [SCOPE],
    });
  };
  app.get("/.well-known/oauth-authorization-server", authServerMetadata);
  app.get("/.well-known/openid-configuration", authServerMetadata);

  // Dynamic client registration (RFC 7591). The client id is a signed description of the client.
  app.post("/register", async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (!body) return oauthError(c, 400, "invalid_client_metadata", "Corps JSON attendu");
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every((u) => typeof u === "string")) {
      return oauthError(c, 400, "invalid_redirect_uri", "redirect_uris doit être une liste non vide");
    }
    const bad = (uris as string[]).filter((u) => !isAllowedRedirectUri(u, config.auth.allowedRedirectHosts));
    if (bad.length > 0) {
      logger.warn("oauth.register.rejected_redirect", { count: bad.length });
      return oauthError(c, 400, "invalid_redirect_uri", "redirect_uri non autorisée (voir OAUTH_ALLOWED_REDIRECT_HOSTS)");
    }
    const requested = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none";
    if (!["none", "client_secret_post", "client_secret_basic"].includes(requested)) {
      return oauthError(c, 400, "invalid_client_metadata", "token_endpoint_auth_method non supportée");
    }
    const authMethod = requested as AuthMethod;
    const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 100) : "Client MCP";
    const clientId = await signer.sign("client", { redirect_uris: uris, client_name: clientName, auth_method: authMethod });
    const response: Record<string, unknown> = {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: clientName,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: authMethod,
    };
    if (authMethod !== "none") {
      response.client_secret = await signer.mac("client", clientId);
      response.client_secret_expires_at = 0;
    }
    logger.info("oauth.register.ok", { client_name: clientName, auth_method: authMethod });
    return c.json(response, 201, { "Cache-Control": "no-store" });
  });

  app.get("/authorize", async (c) => {
    const q = c.req.query();
    const client = await verifyClient(q.client_id);
    if (!client) return c.html(errorPage("Client inconnu : reconnecter le connecteur depuis Claude."), 400, htmlHeaders());
    const redirectUri = q.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
      return c.html(errorPage("redirect_uri non enregistrée pour ce client."), 400, htmlHeaders());
    }
    if (q.response_type !== "code") {
      return redirectWith(redirectUri, { error: "unsupported_response_type", state: q.state });
    }
    if (!q.code_challenge || q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) {
      return redirectWith(redirectUri, { error: "invalid_request", error_description: "PKCE S256 requis", state: q.state });
    }
    const requestToken = await signer.sign(
      "authreq",
      {
        client_id: q.client_id as string,
        redirect_uri: redirectUri,
        code_challenge: q.code_challenge,
        state: q.state,
        scope: SCOPE,
      } satisfies AuthRequestClaims,
      AUTH_REQUEST_TTL,
    );
    const redirectOrigin = new URL(redirectUri).origin;
    return c.html(
      consentPage({ requestToken, clientName: client.client_name, redirectHost: new URL(redirectUri).host }),
      200,
      htmlHeaders(redirectOrigin),
    );
  });

  app.post("/authorize", async (c) => {
    const form = await readForm(c);
    const req = await signer.verify<AuthRequestClaims>("authreq", form.request ?? "");
    if (!req) return c.html(errorPage("Demande expirée ou invalide : relancer la connexion depuis Claude."), 400, htmlHeaders());
    const client = await verifyClient(req.client_id);
    if (!client || !client.redirect_uris.includes(req.redirect_uri)) {
      return c.html(errorPage("Client inconnu."), 400, htmlHeaders());
    }
    const redirectOrigin = new URL(req.redirect_uri).origin;

    if (form.action === "deny") {
      logger.info("oauth.authorize.denied");
      return redirectWith(req.redirect_uri, { error: "access_denied", state: req.state });
    }
    if (failures.locked()) {
      logger.warn("oauth.authorize.locked");
      return c.html(errorPage("Trop de tentatives échouées. Réessayer dans 15 minutes."), 429, htmlHeaders());
    }
    const account = await findAccountByConnectorPassword(config.accounts, form.password ?? "");
    if (!account) {
      failures.record();
      logger.warn("oauth.authorize.bad_password");
      return c.html(
        consentPage({
          requestToken: form.request as string,
          clientName: client.client_name,
          redirectHost: new URL(req.redirect_uri).host,
          error: "Mot de passe incorrect.",
        }),
        401,
        htmlHeaders(redirectOrigin),
      );
    }
    failures.reset();
    const code = await signer.sign(
      "code",
      {
        client_id: req.client_id,
        redirect_uri: req.redirect_uri,
        code_challenge: req.code_challenge,
        scope: req.scope,
        sub: account.id,
      },
      CODE_TTL,
    );
    logger.info("oauth.authorize.approved", { client_name: client.client_name, account: account.id });
    return redirectWith(req.redirect_uri, { code, state: req.state });
  });

  app.post("/token", async (c) => {
    const form = await readForm(c);
    let clientId = form.client_id;
    let clientSecret = form.client_secret;
    const basic = c.req.header("authorization");
    if (basic?.startsWith("Basic ")) {
      try {
        const [id, secret] = atob(basic.slice(6)).split(":");
        clientId = id ? decodeURIComponent(id) : clientId;
        clientSecret = secret !== undefined ? decodeURIComponent(secret) : clientSecret;
      } catch {
        return oauthError(c, 401, "invalid_client", "En-tête Basic invalide");
      }
    }
    const client = await verifyClient(clientId);
    if (!client || !clientId) return oauthError(c, 401, "invalid_client", "Client inconnu");
    if (client.auth_method !== "none") {
      const expected = await signer.mac("client", clientId);
      if (!clientSecret || !(await safeEqual(clientSecret, expected))) return oauthError(c, 401, "invalid_client", "Secret client invalide");
    }

    const issue = async (sub: string, scope: string) => {
      const access_token = await signer.sign("access", { sub, client_id: clientId, scope }, ACCESS_TOKEN_TTL);
      const refresh_token = await signer.sign("refresh", { sub, client_id: clientId, scope } satisfies RefreshClaims, REFRESH_TOKEN_TTL);
      return c.json({ access_token, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL, refresh_token, scope }, 200, {
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      });
    };

    if (form.grant_type === "authorization_code") {
      const code = await signer.verify<CodeClaims>("code", form.code ?? "");
      if (!code || code.client_id !== clientId) return oauthError(c, 400, "invalid_grant", "Code invalide ou expiré");
      if (form.redirect_uri !== undefined && form.redirect_uri !== code.redirect_uri) {
        return oauthError(c, 400, "invalid_grant", "redirect_uri différente");
      }
      const verifier = form.code_verifier ?? "";
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || (await sha256Base64Url(verifier)) !== code.code_challenge) {
        logger.warn("oauth.token.pkce_failed");
        return oauthError(c, 400, "invalid_grant", "code_verifier invalide");
      }
      if (!code.jti || !usedCodes.consume(code.jti, code.exp ?? 0)) return oauthError(c, 400, "invalid_grant", "Code déjà utilisé");
      logger.info("oauth.token.issued", { grant: "authorization_code" });
      return issue(code.sub, code.scope);
    }

    if (form.grant_type === "refresh_token") {
      const rt = await signer.verify<RefreshClaims>("refresh", form.refresh_token ?? "");
      if (!rt || rt.client_id !== clientId) return oauthError(c, 400, "invalid_grant", "Refresh token invalide ou expiré");
      if (!config.accounts.some((a) => a.id === rt.sub)) return oauthError(c, 400, "invalid_grant", "Compte supprimé de la configuration");
      logger.info("oauth.token.issued", { grant: "refresh_token" });
      return issue(rt.sub, rt.scope);
    }

    return oauthError(c, 400, "unsupported_grant_type", "grant_type non supporté");
  });
}

/**
 * Returns the account whose connector password matches. Every account is compared
 * (no early exit) so the response time does not reveal which one matched.
 */
export async function findAccountByConnectorPassword(accounts: AccountConfig[], password: string): Promise<AccountConfig | undefined> {
  let found: AccountConfig | undefined;
  for (const a of accounts) {
    if ((await safeEqual(password, a.connectorPassword)) && !found) found = a;
  }
  return password ? found : undefined;
}

/**
 * Resolves the MCP principal (= SAM account id) of a request, or undefined if the bearer
 * token is not valid or points to an account that is no longer configured.
 */
export async function authenticateBearer(
  header: string | undefined,
  config: Config,
  signer: TokenSigner,
): Promise<{ principal: string; clientId: string; token: string; expiresAt?: number } | undefined> {
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice(7).trim();
  if (!token) return undefined;
  let staticMatch: AccountConfig | undefined;
  for (const a of config.accounts) {
    if (a.staticToken && (await safeEqual(token, a.staticToken)) && !staticMatch) staticMatch = a;
  }
  if (staticMatch) return { principal: staticMatch.id, clientId: "static-token", token };
  const claims = await signer.verify<{ sub?: string; client_id?: string; exp?: number }>("access", token);
  if (!claims?.sub || !config.accounts.some((a) => a.id === claims.sub)) return undefined;
  return { principal: claims.sub, clientId: claims.client_id ?? "unknown", token, expiresAt: claims.exp };
}
