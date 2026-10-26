import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMockSam } from "../src/mock/sam-mock.js";
import { ACCOUNTS, BASE, connectClient, multiEnv, oauthFlow, parseResult, setupMulti, textOf } from "./helpers.js";

const dataCalls = (sam: ReturnType<typeof setupMulti>["sam"]) => sam.calls.filter((c) => c.path.startsWith("/crm-api/"));

describe("plusieurs comptes SAM", () => {
  it("lit les deux comptes depuis SAM_ACCOUNT_<N>_*", () => {
    const config = loadConfig(multiEnv());
    expect(config.accounts.map((a) => [a.id, a.label, a.email])).toEqual([
      ["1", "Commercial A", ACCOUNTS.a.email],
      ["2", "Commercial B", ACCOUNTS.b.email],
    ]);
  });

  it("le mot de passe du connecteur saisi détermine le compte SAM utilisé", async () => {
    const { appFetch, sam } = setupMulti();
    for (const [acc, expectedEmail] of [
      [ACCOUNTS.a, ACCOUNTS.a.email],
      [ACCOUNTS.b, ACCOUNTS.b.email],
    ] as const) {
      const flow = await oauthFlow(appFetch, acc.connector);
      expect(flow.tokenRes?.status).toBe(200);
      const { access_token } = (await flow.tokenRes?.json()) as { access_token: string };
      const client = await connectClient(appFetch, access_token);
      expect(client.getInstructions()).toContain(acc.label);
      const before = dataCalls(sam).length;
      await client.callTool({ name: "search_clients", arguments: { limit: 1 } });
      const calls = dataCalls(sam).slice(before);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((c) => c.user === expectedEmail)).toBe(true);
      await client.close();
    }
    expect(sam.logins).toBe(2); // one SAM session per account
  });

  it("chaque compte a son jeton statique", async () => {
    const { appFetch, sam } = setupMulti();
    const a = await connectClient(appFetch, ACCOUNTS.a.token);
    const b = await connectClient(appFetch, ACCOUNTS.b.token);
    await a.callTool({ name: "get_crm_stats", arguments: {} });
    await b.callTool({ name: "get_crm_stats", arguments: {} });
    const users = sam.calls.filter((c) => c.path === "/crm-api/stats").map((c) => c.user);
    expect(users).toEqual([ACCOUNTS.a.email, ACCOUNTS.b.email]);
    await a.close();
    await b.close();
  });

  it("une confirmation obtenue par un compte ne peut pas servir à l'autre", async () => {
    const { appFetch, sam } = setupMulti();
    const a = await connectClient(appFetch, ACCOUNTS.a.token);
    const b = await connectClient(appFetch, ACCOUNTS.b.token);
    const args = { data: { nom: "Prospect partagé" } };
    const preview = parseResult(await a.callTool({ name: "create_lead", arguments: args }));
    const stolen = await b.callTool({ name: "create_lead", arguments: { ...args, confirmation_token: preview.confirmation_token } });
    expect(stolen.isError).toBe(true);
    expect(textOf(stolen)).toContain("invalide");
    expect(sam.calls.some((c) => c.method === "POST" && c.path === "/crm-api/leads")).toBe(false);
    const ok = await a.callTool({ name: "create_lead", arguments: { ...args, confirmation_token: preview.confirmation_token } });
    expect(ok.isError).toBeFalsy();
    expect(sam.calls.find((c) => c.method === "POST" && c.path === "/crm-api/leads")?.user).toBe(ACCOUNTS.a.email);
    await a.close();
    await b.close();
  });

  it("les droits SAM restent propres à chaque compte", async () => {
    const { appFetch } = setupMulti({ bHasSamRole: false });
    const a = await connectClient(appFetch, ACCOUNTS.a.token);
    const b = await connectClient(appFetch, ACCOUNTS.b.token);
    expect((await a.callTool({ name: "search_clients", arguments: {} })).isError).toBeFalsy();
    const denied = await b.callTool({ name: "search_clients", arguments: {} });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("rôle SAM");
    await a.close();
    await b.close();
  });

  it("refuse un mot de passe SAM saisi à la place du mot de passe du connecteur", async () => {
    const { appFetch } = setupMulti();
    const flow = await oauthFlow(appFetch, ACCOUNTS.a.password);
    expect(flow.post.status).toBe(401);
    expect(flow.code).toBeNull();
  });

  it("révoque les jetons d'un compte retiré de la configuration", async () => {
    const { appFetch } = setupMulti();
    const flow = await oauthFlow(appFetch, ACCOUNTS.b.connector);
    const { access_token, refresh_token } = (await flow.tokenRes?.json()) as { access_token: string; refresh_token: string };

    // Same secret, but account 2 removed.
    const env = multiEnv();
    for (const k of Object.keys(env)) if (k.startsWith("SAM_ACCOUNT_2_")) delete env[k];
    const app = createApp({ config: loadConfig(env), samFetch: createMockSam({ users: [{ email: ACCOUNTS.a.email, password: ACCOUNTS.a.password }] }).fetch });
    const init = new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
    });
    expect((await app.fetch(init)).status).toBe(401);
    expect((await app.fetch(new Request(`${BASE}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${ACCOUNTS.b.token}` } }))).status).toBe(401);
    const refresh = await app.fetch(
      new Request(`${BASE}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token, client_id: flow.client_id }),
      }),
    );
    expect(refresh.status).toBe(400);
  });
});

describe("validation de la configuration multi-comptes", () => {
  const expectError = (env: Record<string, string>, fragment: string, leaked?: string) => {
    let msg = "";
    try {
      loadConfig(env);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain(fragment);
    if (leaked) expect(msg).not.toContain(leaked);
  };

  it("exige des mots de passe de connecteur différents", () => {
    expectError(multiEnv({ SAM_ACCOUNT_2_CONNECTOR_PASSWORD: ACCOUNTS.a.connector }), "différent", ACCOUNTS.a.connector);
  });

  it("refuse un mot de passe de connecteur identique au mot de passe SAM", () => {
    expectError(multiEnv({ SAM_ACCOUNT_1_CONNECTOR_PASSWORD: ACCOUNTS.a.password }), "différent de son mot de passe SAM", ACCOUNTS.a.password);
  });

  it("signale un compte incomplet", () => {
    expectError(multiEnv({ SAM_ACCOUNT_2_PASSWORD: "" }), "SAM_ACCOUNT_2_EMAIL et SAM_ACCOUNT_2_PASSWORD");
  });

  it("refuse de mélanger les deux styles de configuration", () => {
    expectError(multiEnv({ SAM_EMAIL: "x@y.z" }), "pas les deux");
  });
});
