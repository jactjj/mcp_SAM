import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { createMockSam } from "../src/mock/sam-mock.js";
import { SamTokenManager } from "../src/sam/auth.js";
import { SamClient } from "../src/sam/client.js";
import { SamApiError } from "../src/sam/errors.js";
import { SAM_BASE, TEST_SECRETS } from "./helpers.js";

function build(opts: { password?: string; now?: () => number; ttl?: number } = {}) {
  const sam = createMockSam({ email: TEST_SECRETS.samEmail, password: TEST_SECRETS.samPassword, tokenTtlSeconds: opts.ttl, now: opts.now });
  const logger = createLogger("error");
  const tokens = new SamTokenManager({
    baseUrl: SAM_BASE,
    credentials: { accountId: "1", label: "Compte 1", email: TEST_SECRETS.samEmail, password: opts.password ?? TEST_SECRETS.samPassword },
    fetch: sam.fetch,
    logger,
    timeoutMs: 5000,
    now: opts.now,
  });
  const client = new SamClient({ baseUrl: SAM_BASE, fetch: sam.fetch, tokens, logger, timeoutMs: 5000 });
  return { sam, tokens, client };
}

describe("authentification SAM", () => {
  it("s'authentifie une seule fois et réutilise le JWT", async () => {
    const { sam, client } = build();
    await client.list("clients", { limit: 5, offset: 0 });
    await client.get("clients", "c-1");
    await client.stats();
    expect(sam.logins).toBe(1);
    const auth = sam.calls.find((c) => c.path === "/crm-api-auth");
    expect(auth?.body).toEqual({ email: TEST_SECRETS.samEmail, password: TEST_SECRETS.samPassword });
    expect(sam.calls.filter((c) => c.path !== "/crm-api-auth").every((c) => c.authorized)).toBe(true);
  });

  it("partage une seule connexion entre appels concurrents", async () => {
    const { sam, client } = build();
    await Promise.all([1, 2, 3, 4, 5].map(() => client.list("leads", { limit: 1, offset: 0 })));
    expect(sam.logins).toBe(1);
  });

  it("se réauthentifie après un 401 et réessaie une seule fois", async () => {
    const { sam, client } = build();
    await client.stats();
    sam.expireAllTokens();
    const res = await client.list("clients", { limit: 1, offset: 0 });
    expect(res.items).toHaveLength(1);
    expect(sam.logins).toBe(2);
    const dataCalls = sam.calls.filter((c) => c.path === "/crm-api/clients");
    expect(dataCalls.map((c) => c.authorized)).toEqual([false, true]);
  });

  it("abandonne après une seule nouvelle tentative si le 401 persiste", async () => {
    const { sam, client } = build();
    sam.failNext("/crm-api/clients", 401);
    sam.failNext("/crm-api/clients", 401);
    const err = await client.list("clients", { limit: 1, offset: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(SamApiError);
    expect((err as SamApiError).code).toBe("auth_failed");
    expect(sam.calls.filter((c) => c.path === "/crm-api/clients")).toHaveLength(2);
    expect(sam.logins).toBe(2);
  });

  it("renouvelle le JWT avant son expiration (expires_at)", async () => {
    let now = 1_000_000_000_000;
    const { sam, client } = build({ now: () => now, ttl: 3600 });
    await client.stats();
    now += 3_000_000; // 50 min : encore valide
    await client.stats();
    expect(sam.logins).toBe(1);
    now += 570_000; // 59,5 min : dans la marge de renouvellement
    await client.stats();
    expect(sam.logins).toBe(2);
    expect(sam.calls.filter((c) => c.path === "/crm-api/stats").every((c) => c.authorized)).toBe(true);
  });

  it("signale des identifiants refusés sans exposer le mot de passe", async () => {
    const { client } = build({ password: "wrong-password-xyz" });
    const err = (await client.stats().catch((e) => e)) as SamApiError;
    expect(err.code).toBe("auth_failed");
    expect(err.message).not.toContain("wrong-password-xyz");
    expect(err.message).toContain("SAM_EMAIL");
  });

  it("signale une API injoignable", async () => {
    const logger = createLogger("error");
    const failingFetch = async () => {
      throw new TypeError("fetch failed");
    };
    const tokens = new SamTokenManager({
      baseUrl: SAM_BASE,
      credentials: { accountId: "1", label: "Compte 1", email: "a@b.c", password: "p" },
      fetch: failingFetch,
      logger,
      timeoutMs: 1000,
    });
    const err = (await tokens.getToken().catch((e) => e)) as SamApiError;
    expect(err.code).toBe("network_error");
  });
});
