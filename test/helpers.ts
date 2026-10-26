import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMockSam, type MockSam, type MockSamOptions } from "../src/mock/sam-mock.js";
import { base64Url, sha256Base64Url } from "../src/security/signer.js";

export const TEST_SECRETS = {
  samEmail: "demo@sam.test",
  samPassword: "S4m-Pa55word-NeverLog!",
  authSecret: "test-auth-secret-0123456789-abcdefghijklmnop",
  ownerPassword: "Owner-Pa55phrase-Secret",
  staticToken: "static-token-0123456789-abcdefghijklmnopqrstuvwxyz",
};

export const BASE = "https://mcp.test";
export const SAM_BASE = "https://sam.test/functions/v1";

export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    SAM_API_BASE_URL: SAM_BASE,
    SAM_EMAIL: TEST_SECRETS.samEmail,
    SAM_PASSWORD: TEST_SECRETS.samPassword,
    MCP_AUTH_SECRET: TEST_SECRETS.authSecret,
    MCP_OWNER_PASSWORD: TEST_SECRETS.ownerPassword,
    MCP_STATIC_TOKEN: TEST_SECRETS.staticToken,
    MCP_PUBLIC_URL: BASE,
    LOG_LEVEL: "debug",
    ...overrides,
  };
}

export function setup(opts: { env?: Record<string, string>; mock?: MockSamOptions } = {}) {
  const sam: MockSam = createMockSam({ email: TEST_SECRETS.samEmail, password: TEST_SECRETS.samPassword, ...opts.mock });
  const config = loadConfig(testEnv(opts.env));
  const app = createApp({ config, samFetch: sam.fetch });
  const appFetch = (input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(app.fetch(input instanceof Request ? input : new Request(input, init)));
  return { app, sam, config, appFetch };
}

export async function connectClient(
  appFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  token: string = TEST_SECRETS.staticToken,
) {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch: appFetch,
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

export function parseResult(result: unknown): any {
  const r = result as CallToolResult;
  const first = r.content[0];
  if (!first || first.type !== "text") throw new Error("Résultat texte attendu");
  try {
    return JSON.parse(first.text);
  } catch {
    return first.text;
  }
}

export function textOf(result: unknown): string {
  const r = result as CallToolResult;
  const first = r.content[0];
  return first && first.type === "text" ? first.text : "";
}

/** Runs the full Claude.ai-style OAuth flow (DCR + PKCE) and returns the token response. */
export async function oauthFlow(
  appFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  password: string = TEST_SECRETS.ownerPassword,
) {
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const reg = await appFetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
  });
  const { client_id } = (await reg.json()) as { client_id: string };
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = await sha256Base64Url(verifier);
  const q = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
  });
  const page = await appFetch(`${BASE}/authorize?${q}`);
  const html = await page.text();
  const requestToken = /name="request" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const post = await appFetch(`${BASE}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request: requestToken, password, action: "approve" }),
    redirect: "manual",
  });
  const location = post.headers.get("location");
  const code = location ? new URL(location).searchParams.get("code") : null;
  const tokenRes = code
    ? await appFetch(`${BASE}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: redirectUri }),
      })
    : undefined;
  return { client_id, verifier, challenge, redirectUri, page, html, post, location, code, tokenRes };
}

export const ACCOUNTS = {
  a: {
    label: "Commercial A",
    email: "alice@sam.test",
    password: "Alice-SAM-Pa55!",
    connector: "Alice-connecteur-123",
    token: "alice-static-token-0123456789-abcdefghijkl",
  },
  b: {
    label: "Commercial B",
    email: "bruno@sam.test",
    password: "Bruno-SAM-Pa55!",
    connector: "Bruno-connecteur-456",
    token: "bruno-static-token-0123456789-abcdefghijkl",
  },
};

export function multiEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    SAM_API_BASE_URL: SAM_BASE,
    MCP_AUTH_SECRET: TEST_SECRETS.authSecret,
    MCP_PUBLIC_URL: BASE,
    LOG_LEVEL: "debug",
  };
  [ACCOUNTS.a, ACCOUNTS.b].forEach((acc, i) => {
    const p = `SAM_ACCOUNT_${i + 1}_`;
    env[`${p}LABEL`] = acc.label;
    env[`${p}EMAIL`] = acc.email;
    env[`${p}PASSWORD`] = acc.password;
    env[`${p}CONNECTOR_PASSWORD`] = acc.connector;
    env[`${p}STATIC_TOKEN`] = acc.token;
  });
  return { ...env, ...overrides };
}

export function setupMulti(opts: { env?: Record<string, string>; bHasSamRole?: boolean } = {}) {
  const sam: MockSam = createMockSam({
    users: [
      { email: ACCOUNTS.a.email, password: ACCOUNTS.a.password },
      { email: ACCOUNTS.b.email, password: ACCOUNTS.b.password, hasSamRole: opts.bHasSamRole },
    ],
  });
  const config = loadConfig(multiEnv(opts.env));
  const app = createApp({ config, samFetch: sam.fetch });
  const appFetch = (input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(app.fetch(input instanceof Request ? input : new Request(input, init)));
  return { app, sam, config, appFetch };
}
