import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker.js";
import { BASE, testEnv } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

describe("point d'entrée Cloudflare Worker", () => {
  it("répond sur /health avec une configuration valide (API simulée)", async () => {
    const env = testEnv({ SAM_MOCK: "true" });
    const res = await worker.fetch(new Request(`${BASE}/health`), env, {});
    expect(res.status).toBe(200);
  });

  it("renvoie 500 sans divulguer la configuration si des secrets manquent", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await worker.fetch(new Request(`${BASE}/health`), { SAM_EMAIL: "a@b.c", SAM_PASSWORD: "secret-value-123" }, {});
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("MCP_AUTH_SECRET");
    expect(spy.mock.calls.flat().join(" ")).not.toContain("secret-value-123");
  });
});
