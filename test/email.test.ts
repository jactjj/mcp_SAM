import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connectClient, parseResult, setup, textOf } from "./helpers.js";

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
  vi.restoreAllMocks();
});

const email = { to: "destinataire@example.com", subject: "Relance devis", html: "<p>Bonjour,</p><p>Suite à notre échange…</p>" };

describe("send_email", () => {
  it("n'existe pas tant que SAM_SEND_EMAIL n'est pas activé", async () => {
    const { appFetch } = setup({ env: { SAM_WRITE_MODE: "direct" } });
    client = await connectClient(appFetch);
    expect((await client.listTools()).tools.some((t) => t.name === "send_email")).toBe(false);
  });

  it("n'existe pas en lecture seule, même activé", async () => {
    const { appFetch } = setup({ env: { SAM_WRITE_MODE: "disabled", SAM_SEND_EMAIL: "true" } });
    client = await connectClient(appFetch);
    expect((await client.listTools()).tools.some((t) => t.name === "send_email")).toBe(false);
  });

  it("envoie immédiatement en mode direct avec les champs attendus par SAM", async () => {
    const { appFetch, sam } = setup({ env: { SAM_WRITE_MODE: "direct", SAM_SEND_EMAIL: "true" } });
    client = await connectClient(appFetch);
    const tool = (await client.listTools()).tools.find((t) => t.name === "send_email");
    expect(tool?.annotations?.openWorldHint).toBe(true);
    const res = parseResult(await client.callTool({ name: "send_email", arguments: email }));
    expect(res.status).toBe("envoyé");
    expect(sam.sentEmails).toEqual([{ ...email, to: [email.to] }]);
  });

  it("en mode confirm, l'aperçu n'envoie rien", async () => {
    const { appFetch, sam } = setup({ env: { SAM_WRITE_MODE: "confirm", SAM_SEND_EMAIL: "true" } });
    client = await connectClient(appFetch);
    const preview = parseResult(await client.callTool({ name: "send_email", arguments: email }));
    expect(preview.status).toBe("confirmation_requise");
    expect(preview.apercu_texte).toContain("Suite à notre échange");
    expect(sam.sentEmails).toHaveLength(0);
    const changed = await client.callTool({ name: "send_email", arguments: { ...email, to: "autre@example.com", confirmation_token: preview.confirmation_token } });
    expect(changed.isError).toBe(true);
    await client.callTool({ name: "send_email", arguments: { ...email, confirmation_token: preview.confirmation_token } });
    expect(sam.sentEmails).toHaveLength(1);
  });

  it("refuse une adresse invalide ou plusieurs destinataires", async () => {
    const { appFetch, sam } = setup({ env: { SAM_WRITE_MODE: "direct", SAM_SEND_EMAIL: "true" } });
    client = await connectClient(appFetch);
    for (const to of ["pas-une-adresse", "a@example.com, b@example.com"]) {
      const outcome = await client.callTool({ name: "send_email", arguments: { ...email, to } }).then(
        (r) => r.isError === true,
        () => true,
      );
      expect(outcome).toBe(true);
    }
    expect(sam.sentEmails).toHaveLength(0);
  });

  it("ne journalise ni le destinataire ni le contenu", async () => {
    const lines: string[] = [];
    for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    const { appFetch } = setup({ env: { SAM_WRITE_MODE: "direct", SAM_SEND_EMAIL: "true" } });
    client = await connectClient(appFetch);
    await client.callTool({ name: "send_email", arguments: email });
    const all = lines.join("\n");
    expect(all).toContain("tool.email.sent");
    expect(all).not.toContain(email.to);
    expect(all).not.toContain("Relance devis");
    expect(textOf({ content: [{ type: "text", text: "" }] })).toBe("");
  });
});
