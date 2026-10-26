import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { redact, redactString } from "../src/logger.js";
import { TEST_SECRETS, connectClient, oauthFlow, setup, testEnv } from "./helpers.js";

let output: string[] = [];
beforeEach(() => {
  output = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      output.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
});
afterEach(() => vi.restoreAllMocks());

describe("absence de secrets dans les logs", () => {
  it("ne journalise ni identifiants, ni JWT SAM, ni jetons MCP sur un parcours complet", async () => {
    const { appFetch, sam } = setup();
    const flow = await oauthFlow(appFetch);
    const tokens = (await flow.tokenRes?.json()) as { access_token: string; refresh_token: string };
    await oauthFlow(appFetch, "wrong-password-attempt");

    const client = await connectClient(appFetch, tokens.access_token);
    await client.callTool({ name: "search_clients", arguments: { search: "dupont" } });
    sam.expireAllTokens(); // force a re-authentication
    await client.callTool({ name: "get_client", arguments: { id: "c-1" } });
    const preview = await client.callTool({ name: "create_lead", arguments: { data: { nom: "Test" } } });
    sam.failNext("/crm-api/leads", 500, { error: `fuite ${TEST_SECRETS.samPassword}` });
    await client.callTool({ name: "search_leads", arguments: {} });
    await client.close();

    expect(output.length).toBeGreaterThan(5);
    const all = output.join("\n");
    const secrets = [
      TEST_SECRETS.samPassword,
      TEST_SECRETS.authSecret,
      TEST_SECRETS.ownerPassword,
      TEST_SECRETS.staticToken,
      tokens.access_token,
      tokens.refresh_token,
      flow.code as string,
      flow.verifier,
      ...sam.issuedTokens,
    ];
    for (const s of secrets) expect(all).not.toContain(s);
    expect(all).not.toContain("wrong-password-attempt");
    expect(all).not.toContain("dupont"); // search terms (personal data) are not logged
    expect(JSON.stringify(preview)).not.toContain(TEST_SECRETS.samPassword);
  });

  it("une erreur de configuration nomme les variables sans afficher leurs valeurs", () => {
    let message = "";
    try {
      loadConfig(testEnv({ MCP_AUTH_SECRET: "short-secret-value" }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("MCP_AUTH_SECRET");
    expect(message).not.toContain("short-secret-value");
  });
});

describe("redaction", () => {
  it("masque les clés sensibles et les JWT dans le texte", () => {
    const out = redact({
      password: "p",
      nested: { access_token: "t", note: "Bearer abc.def.ghi" },
      msg: "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
    }) as Record<string, any>;
    expect(out.password).toBe("[REDACTED]");
    expect(out.nested.access_token).toBe("[REDACTED]");
    expect(out.nested.note).toBe("Bearer [REDACTED]");
    expect(out.msg).toContain("[REDACTED_JWT]");
    expect(redactString("mot de passe: hunter22", ["hunter22"])).toBe("mot de passe: [REDACTED]");
  });
});
