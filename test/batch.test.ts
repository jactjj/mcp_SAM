import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connectClient, parseResult, setup, textOf } from "./helpers.js";

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

const writes = (sam: ReturnType<typeof setup>["sam"]) => sam.calls.filter((c) => c.method !== "GET" && c.path !== "/crm-api-auth");

describe("batch_write", () => {
  it("exécute créations, modifications et suppressions en un seul appel", async () => {
    const { appFetch, sam } = setup({ env: { SAM_WRITE_MODE: "direct" } });
    client = await connectClient(appFetch);
    const res = parseResult(
      await client.callTool({
        name: "batch_write",
        arguments: {
          operations: [
            { action: "create", entity: "client-comments", data: { client_id: "c-1", contenu: "Appel 1" } },
            { action: "create", entity: "client-comments", data: { client_id: "c-1", contenu: "Appel 2" } },
            { action: "update", entity: "clients", id: "c-1", data: { ville: "Nice" } },
            { action: "delete", entity: "leads", id: "l-1" },
          ],
        },
      }),
    );
    expect(res).toMatchObject({ status: "terminé", total: 4, reussies: 4, echecs: 0 });
    expect(res.resultats[0].id).toBeTruthy();
    expect(sam.data.get("client-comments")).toHaveLength(3);
    expect(sam.data.get("clients")?.find((c) => c.id === "c-1")?.ville).toBe("Nice");
    expect(sam.data.get("leads")).toHaveLength(0);
  });

  it("refuse tout le lot si une opération est invalide, sans rien écrire", async () => {
    const { appFetch, sam } = setup({ env: { SAM_WRITE_MODE: "direct" } });
    client = await connectClient(appFetch);
    const res = await client.callTool({
      name: "batch_write",
      arguments: {
        operations: [
          { action: "create", entity: "taches", data: { titre: "OK" } },
          { action: "update", entity: "clients", data: { ville: "X" } },
          { action: "create", entity: "leads", data: { nom: "X", couleur: "bleu" } },
          { action: "update", entity: "clients", id: "c-1", data: { deleted_at: "2026-01-01" } },
          { action: "create", entity: "commerciaux", data: { nom: "X", user_id: "u-9" } },
          { action: "create", entity: "notifications", data: { titre: "X" } },
        ],
      },
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("rien n'a été écrit");
    for (const n of ["opération 2", "opération 3", "opération 4", "opération 5", "opération 6"]) expect(text).toContain(n);
    expect(text).not.toContain("opération 1 ");
    expect(writes(sam)).toHaveLength(0);
  });

  it("continue après une erreur SAM, ou s'arrête avec stop_on_error", async () => {
    const ops = [
      { action: "update", entity: "clients", id: "c-1", data: { ville: "A" } },
      { action: "update", entity: "clients", id: "inexistant", data: { ville: "B" } },
      { action: "update", entity: "clients", id: "c-2", data: { ville: "C" } },
    ];
    const first = setup({ env: { SAM_WRITE_MODE: "direct" } });
    client = await connectClient(first.appFetch);
    const res = parseResult(await client.callTool({ name: "batch_write", arguments: { operations: ops } }));
    expect(res).toMatchObject({ status: "terminé_avec_erreurs", reussies: 2, echecs: 1, non_executees: 0 });
    expect(res.resultats[1].message).toContain("introuvable");
    await client.close();

    const second = setup({ env: { SAM_WRITE_MODE: "direct" } });
    client = await connectClient(second.appFetch);
    const stopped = parseResult(await client.callTool({ name: "batch_write", arguments: { operations: ops, stop_on_error: true } }));
    expect(stopped).toMatchObject({ reussies: 1, echecs: 1, non_executees: 1 });
    expect(second.sam.data.get("clients")?.find((c) => c.id === "c-2")?.ville).toBe("Paris");
  });

  it("en mode confirm, un seul aperçu et un seul jeton pour tout le lot", async () => {
    const { appFetch, sam } = setup({ env: { SAM_WRITE_MODE: "confirm" } });
    client = await connectClient(appFetch);
    const operations = Array.from({ length: 30 }, (_, i) => ({ action: "create", entity: "client-comments", data: { client_id: "c-2", contenu: `Note ${i}` } }));
    const preview = parseResult(await client.callTool({ name: "batch_write", arguments: { operations } }));
    expect(preview.status).toBe("confirmation_requise");
    expect(preview.resume.creations).toBe(30);
    expect(writes(sam)).toHaveLength(0);
    const tampered = await client.callTool({ name: "batch_write", arguments: { operations: operations.slice(1), confirmation_token: preview.confirmation_token } });
    expect(tampered.isError).toBe(true);
    const done = parseResult(await client.callTool({ name: "batch_write", arguments: { operations, confirmation_token: preview.confirmation_token } }));
    expect(done.reussies).toBe(30);
    expect(writes(sam)).toHaveLength(30);
  });

  it("limite le lot à 50 opérations", async () => {
    const { appFetch, sam } = setup({ env: { SAM_WRITE_MODE: "direct" } });
    client = await connectClient(appFetch);
    const operations = Array.from({ length: 51 }, () => ({ action: "update", entity: "clients", id: "c-1", data: { ville: "X" } }));
    const refused = await client.callTool({ name: "batch_write", arguments: { operations } }).then((r) => r.isError === true, () => true);
    expect(refused).toBe(true);
    expect(writes(sam)).toHaveLength(0);
  });

  it("n'existe pas en lecture seule", async () => {
    const { appFetch } = setup({ env: { SAM_WRITE_MODE: "disabled" } });
    client = await connectClient(appFetch);
    expect((await client.listTools()).tools.some((t) => t.name === "batch_write")).toBe(false);
  });
});
