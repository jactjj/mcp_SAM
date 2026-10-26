import { describe, expect, it } from "vitest";
import { TokenSigner } from "../src/security/signer.js";
import { BASE, TEST_SECRETS, connectClient, oauthFlow, setup } from "./helpers.js";

const initialize = (token?: string) =>
  new Request(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    }),
  });

describe("découverte OAuth", () => {
  it("publie les métadonnées de ressource protégée et de serveur d'autorisation", async () => {
    const { appFetch } = setup();
    const pr = await (await appFetch(`${BASE}/.well-known/oauth-protected-resource`)).json();
    expect(pr).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });
    const as = await (await appFetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
    expect(as).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/token`,
      registration_endpoint: `${BASE}/register`,
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("le endpoint de santé ne nécessite pas d'authentification et n'appelle pas SAM", async () => {
    const { appFetch, sam } = setup();
    const res = await appFetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect(sam.calls).toHaveLength(0);
  });
});

describe("refus des accès non autorisés", () => {
  it("répond 401 avec WWW-Authenticate sans jeton", async () => {
    const { app, sam } = setup();
    const res = await app.fetch(initialize());
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);
    expect(sam.calls).toHaveLength(0);
  });

  it.each([
    ["jeton aléatoire", "not-a-valid-token"],
    ["jeton SAM", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abc"],
  ])("refuse un %s", async (_l, token) => {
    const { app } = setup();
    expect((await app.fetch(initialize(token))).status).toBe(401);
  });

  it("refuse un jeton signé avec un autre secret ou pour un autre usage", async () => {
    const { app } = setup();
    const foreign = await new TokenSigner("another-secret-0123456789-abcdefghijklmnop").sign("access", { sub: "owner" }, 3600);
    expect((await app.fetch(initialize(foreign))).status).toBe(401);
    const refreshAsAccess = await new TokenSigner(TEST_SECRETS.authSecret).sign("refresh", { sub: "owner" }, 3600);
    expect((await app.fetch(initialize(refreshAsAccess))).status).toBe(401);
  });

  it("refuse un jeton d'accès expiré", async () => {
    const { app } = setup();
    const expired = await new TokenSigner(TEST_SECRETS.authSecret).sign("access", { sub: "owner" }, -10);
    expect((await app.fetch(initialize(expired))).status).toBe(401);
  });

  it("désactive le jeton statique quand MCP_STATIC_TOKEN est vide", async () => {
    const { app } = setup({ env: { MCP_STATIC_TOKEN: "" } });
    expect((await app.fetch(initialize(TEST_SECRETS.staticToken))).status).toBe(401);
  });

  it("accepte le jeton statique configuré", async () => {
    const { app } = setup();
    expect((await app.fetch(initialize(TEST_SECRETS.staticToken))).status).toBe(200);
  });

  it("rejette GET et DELETE sur /mcp (mode sans état)", async () => {
    const { appFetch } = setup();
    const auth = { Authorization: `Bearer ${TEST_SECRETS.staticToken}` };
    expect((await appFetch(`${BASE}/mcp`, { headers: auth })).status).toBe(405);
    expect((await appFetch(`${BASE}/mcp`, { method: "DELETE", headers: auth })).status).toBe(405);
  });
});

describe("flux OAuth Claude.ai (DCR + PKCE)", () => {
  it("délivre un jeton utilisable pour appeler les outils", async () => {
    const { appFetch } = setup();
    const flow = await oauthFlow(appFetch);
    expect(flow.page.status).toBe(200);
    expect(flow.page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(flow.post.status).toBe(302);
    expect(new URL(flow.location as string).searchParams.get("state")).toBe("xyz");
    expect(flow.tokenRes?.status).toBe(200);
    const tokens = (await flow.tokenRes?.json()) as { access_token: string; refresh_token: string; token_type: string };
    expect(tokens.token_type).toBe("Bearer");
    const client = await connectClient(appFetch, tokens.access_token);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(10);
    await client.close();
  });

  it("refuse un mauvais mot de passe et verrouille après 5 échecs", async () => {
    const { appFetch } = setup();
    const bad = await oauthFlow(appFetch, "wrong-password");
    expect(bad.post.status).toBe(401);
    expect(bad.code).toBeNull();
    for (let i = 0; i < 4; i++) await oauthFlow(appFetch, "wrong-password");
    const locked = await oauthFlow(appFetch, TEST_SECRETS.ownerPassword);
    expect(locked.post.status).toBe(429);
    expect(locked.code).toBeNull();
  });

  it("refuse un code_verifier PKCE incorrect et la réutilisation d'un code", async () => {
    const { appFetch } = setup();
    const flow = await oauthFlow(appFetch);
    const exchange = (verifier: string) =>
      appFetch(`${BASE}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: flow.code as string,
          code_verifier: verifier,
          client_id: flow.client_id,
          redirect_uri: flow.redirectUri,
        }),
      });
    // the helper already consumed the code with the right verifier
    const reuse = await exchange(flow.verifier);
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as { error: string }).error).toBe("invalid_grant");

    const flow2 = await oauthFlow(appFetch, "wrong"); // no code
    expect(flow2.code).toBeNull();
  });

  it("refuse un PKCE incorrect", async () => {
    const { appFetch } = setup();
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const reg = (await (
      await appFetch(`${BASE}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      })
    ).json()) as { client_id: string };
    const challenge = "A".repeat(43);
    const page = await (
      await appFetch(
        `${BASE}/authorize?${new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256" })}`,
      )
    ).text();
    const requestToken = /name="request" value="([^"]+)"/.exec(page)?.[1] ?? "";
    const post = await appFetch(`${BASE}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request: requestToken, password: TEST_SECRETS.ownerPassword, action: "approve" }),
    });
    const code = new URL(post.headers.get("location") as string).searchParams.get("code") as string;
    const res = await appFetch(`${BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: "b".repeat(43), client_id: reg.client_id }),
    });
    expect(res.status).toBe(400);
  });

  it("refuse l'enregistrement d'une redirect_uri hors liste autorisée", async () => {
    const { appFetch } = setup();
    for (const uri of ["https://evil.example.com/cb", "http://claude.ai/cb", "https://claude.ai.evil.com/cb"]) {
      const res = await appFetch(`${BASE}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [uri] }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("n'effectue aucune redirection vers une URI non enregistrée", async () => {
    const { appFetch } = setup();
    const flow = await oauthFlow(appFetch);
    const res = await appFetch(
      `${BASE}/authorize?${new URLSearchParams({ response_type: "code", client_id: flow.client_id, redirect_uri: "https://claude.ai/other", code_challenge: flow.challenge, code_challenge_method: "S256" })}`,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("renvoie access_denied si l'utilisateur refuse", async () => {
    const { appFetch } = setup();
    const flow = await oauthFlow(appFetch);
    const requestToken = /name="request" value="([^"]+)"/.exec(flow.html)?.[1] ?? "";
    const res = await appFetch(`${BASE}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request: requestToken, action: "deny" }),
    });
    expect(new URL(res.headers.get("location") as string).searchParams.get("error")).toBe("access_denied");
  });

  it("renouvelle le jeton via refresh_token", async () => {
    const { appFetch, app } = setup();
    const flow = await oauthFlow(appFetch);
    const { refresh_token } = (await flow.tokenRes?.json()) as { refresh_token: string };
    const res = await appFetch(`${BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token, client_id: flow.client_id }),
    });
    expect(res.status).toBe(200);
    const { access_token } = (await res.json()) as { access_token: string };
    expect((await app.fetch(initialize(access_token))).status).toBe(200);
  });

  it("gère les clients confidentiels (client_secret_post)", async () => {
    const { appFetch } = setup();
    const reg = (await (
      await appFetch(`${BASE}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "client_secret_post" }),
      })
    ).json()) as { client_id: string; client_secret: string };
    expect(reg.client_secret).toBeTruthy();
    const res = await appFetch(`${BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "x", client_id: reg.client_id, client_secret: "wrong" }),
    });
    expect(res.status).toBe(401);
  });
});
