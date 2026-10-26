import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connectClient, parseResult, setup, textOf } from "./helpers.js";

const EXPECTED_READ_TOOLS = [
  "search_clients",
  "get_client",
  "search_leads",
  "get_lead",
  "list_commerciaux",
  "list_distributeurs",
  "list_products",
  "get_crm_stats",
  "get_crm_schema",
  "list_tasks",
  "list_appointments",
  "list_documents",
  "get_document",
  "list_notifications",
  "list_client_comments",
  "list_lead_comments",
  "list_client_products",
];
const EXPECTED_WRITE_TOOLS = [
  "create_client",
  "update_client",
  "create_lead",
  "update_lead",
  "create_task",
  "update_task",
  "create_appointment",
  "update_appointment",
  "add_client_comment",
  "add_lead_comment",
  "create_commercial",
  "update_commercial",
];

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe("connexion et découverte", () => {
  it("se connecte et expose les informations du serveur", async () => {
    const { appFetch } = setup();
    client = await connectClient(appFetch);
    expect(client.getServerVersion()?.name).toBe("sam-crm");
    expect(client.getInstructions()).toContain("get_crm_schema");
  });

  it("expose exactement les outils métier attendus, sans suppression, email ni HTTP générique", async () => {
    const { appFetch } = setup();
    client = await connectClient(appFetch);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_READ_TOOLS, ...EXPECTED_WRITE_TOOLS].sort());
    expect(names.some((n) => /delete|remove|email|mail|http|request|fetch/i.test(n))).toBe(false);
    for (const t of tools) {
      expect(t.description && t.description.length).toBeGreaterThan(20);
      if (EXPECTED_READ_TOOLS.includes(t.name)) expect(t.annotations?.readOnlyHint).toBe(true);
      else expect(t.annotations?.readOnlyHint).toBe(false);
    }
    const update = tools.find((t) => t.name === "update_client");
    expect(update?.annotations?.destructiveHint).toBe(true);
    expect(update?.description).toContain("CONTRÔLE HUMAIN");
  });

  it("en mode lecture seule, aucun outil d'écriture n'est exposé", async () => {
    const { appFetch } = setup({ env: { SAM_WRITE_MODE: "disabled" } });
    client = await connectClient(appFetch);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_READ_TOOLS].sort());
  });
});

describe("lecture", () => {
  it("recherche des clients, tronque les textes longs et masque les champs sensibles", async () => {
    const { appFetch, sam } = setup();
    client = await connectClient(appFetch);
    const res = await client.callTool({ name: "search_clients", arguments: { search: "dupont" } });
    expect(res.isError).toBeFalsy();
    const body = parseResult(res);
    expect(body.entity).toBe("clients");
    expect(body.items.map((i: any) => i.nom).sort()).toEqual(["Dupont", "Dupontel"]);
    const luc = body.items.find((i: any) => i.nom === "Dupontel");
    expect(luc.password_hash).toBeUndefined();
    expect(luc.notes.length).toBeLessThan(400);
    expect(luc.notes).toContain("tronqué");
    const call = sam.calls.find((c) => c.path === "/crm-api/clients");
    expect(call?.query).toMatchObject({ search: "dupont", limit: "20", offset: "0" });
  });

  it("applique les filtres et la projection de champs", async () => {
    const { appFetch, sam } = setup();
    client = await connectClient(appFetch);
    const res = await client.callTool({
      name: "search_clients",
      arguments: { filters: [{ field: "ville", value: "Lyon" }, { field: "statut", op: "not", value: "inactif" }], fields: ["nom"] },
    });
    const body = parseResult(res);
    expect(body.items).toHaveLength(2);
    expect(Object.keys(body.items[0]).sort()).toEqual(["id", "nom"]);
    const call = sam.calls.filter((c) => c.path === "/crm-api/clients").at(-1);
    expect(call?.query).toMatchObject({ ville: "Lyon", statut: "not.inactif" });
  });

  it("refuse un filtre sur un champ absent du schéma sans appeler l'API", async () => {
    const { appFetch, sam } = setup();
    client = await connectClient(appFetch);
    const res = await client.callTool({ name: "search_clients", arguments: { filters: [{ field: "champ_invente", value: "x" }] } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Champ(s) inconnu(s)");
    expect(sam.calls.some((c) => c.path === "/crm-api/clients")).toBe(false);
  });

  it("récupère une fiche client et gère l'absence", async () => {
    const { appFetch } = setup();
    client = await connectClient(appFetch);
    const ok = parseResult(await client.callTool({ name: "get_client", arguments: { id: "c-1" } }));
    expect(ok.item.nom).toBe("Dupont");
    const missing = await client.callTool({ name: "get_client", arguments: { id: "inconnu" } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("introuvable");
  });

  it("liste les commentaires d'un client via client_id", async () => {
    const { appFetch, sam } = setup();
    client = await connectClient(appFetch);
    const body = parseResult(await client.callTool({ name: "list_client_comments", arguments: { client_id: "c-1" } }));
    expect(body.items).toHaveLength(1);
    expect(sam.calls.at(-1)?.query.client_id).toBe("c-1");
  });

  it("renvoie les statistiques et le schéma réel", async () => {
    const { appFetch } = setup();
    client = await connectClient(appFetch);
    const stats = parseResult(await client.callTool({ name: "get_crm_stats", arguments: {} }));
    expect(stats.stats).toBeDefined();
    const schema = parseResult(await client.callTool({ name: "get_crm_schema", arguments: { entity: "leads" } }));
    expect(schema.entities).toHaveLength(1);
    expect(schema.entities[0].fields.map((f: any) => f.name)).toContain("nom");
  });
});

describe("validation des paramètres", () => {
  it.each([
    ["limit trop grand", "search_clients", { limit: 500 }],
    ["offset négatif", "search_clients", { offset: -1 }],
    ["identifiant avec traversée de chemin", "get_client", { id: "../stats" }],
    ["opérateur inconnu", "search_clients", { filters: [{ field: "nom", op: "drop", value: "x" }] }],
    ["nom de champ invalide", "search_clients", { filters: [{ field: "nom;--", value: "x" }] }],
    ["recherche trop longue", "search_clients", { search: "x".repeat(101) }],
  ])("refuse : %s", async (_label, name, args) => {
    const { appFetch, sam } = setup();
    client = await connectClient(appFetch);
    const before = sam.calls.length;
    const outcome = await client.callTool({ name, arguments: args }).then(
      (r) => ({ isError: r.isError === true }),
      () => ({ isError: true }),
    );
    expect(outcome.isError).toBe(true);
    expect(sam.calls.length).toBe(before);
  });

  it("refuse les champs inconnus, gérés par SAM ou obligatoires manquants à la création", async () => {
    const { appFetch, sam } = setup();
    client = await connectClient(appFetch);
    const unknown = await client.callTool({ name: "create_lead", arguments: { data: { nom: "X", couleur: "bleu" } } });
    expect(textOf(unknown)).toContain("couleur");
    const managed = await client.callTool({ name: "create_lead", arguments: { data: { nom: "X", id: "forced" } } });
    expect(textOf(managed)).toContain("géré par SAM");
    const softDelete = await client.callTool({ name: "update_client", arguments: { id: "c-1", data: { deleted_at: "2026-01-01" } } });
    expect(softDelete.isError).toBe(true);
    const missing = await client.callTool({ name: "create_lead", arguments: { data: { entreprise: "ACME" } } });
    expect(textOf(missing)).toContain("obligatoire");
    const badType = await client.callTool({ name: "create_lead", arguments: { data: { nom: "X", score: "beaucoup" } } });
    expect(textOf(badType)).toContain("score");
    expect(sam.calls.some((c) => c.method === "POST" && c.path.startsWith("/crm-api/"))).toBe(false);
  });
});

describe("écritures avec contrôle humain (mode confirm)", () => {
  it("crée un prospect en deux temps : aperçu sans écriture, puis confirmation", async () => {
    const { appFetch, sam } = setup();
    client = await connectClient(appFetch);
    const args = { data: { nom: "Lefebvre", entreprise: "Lefebvre SA", statut: "nouveau" } };

    const preview = parseResult(await client.callTool({ name: "create_lead", arguments: args }));
    expect(preview.status).toBe("confirmation_requise");
    expect(preview.changements).toEqual(args.data);
    expect(sam.data.get("leads")).toHaveLength(1);
    expect(sam.calls.some((c) => c.method === "POST" && c.path === "/crm-api/leads")).toBe(false);

    const done = await client.callTool({ name: "create_lead", arguments: { ...args, confirmation_token: preview.confirmation_token } });
    expect(done.isError).toBeFalsy();
    expect(parseResult(done).status).toBe("créé");
    expect(sam.data.get("leads")).toHaveLength(2);

    const replay = await client.callTool({ name: "create_lead", arguments: { ...args, confirmation_token: preview.confirmation_token } });
    expect(replay.isError).toBe(true);
    expect(textOf(replay)).toContain("déjà été utilisé");
    expect(sam.data.get("leads")).toHaveLength(2);
  });

  it("refuse une confirmation dont les paramètres diffèrent de l'aperçu", async () => {
    const { appFetch, sam } = setup();
    client = await connectClient(appFetch);
    const preview = parseResult(await client.callTool({ name: "create_lead", arguments: { data: { nom: "A" } } }));
    const res = await client.callTool({
      name: "create_lead",
      arguments: { data: { nom: "B" }, confirmation_token: preview.confirmation_token },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("ne correspondent pas");
    expect(sam.data.get("leads")).toHaveLength(1);
  });

  it("refuse un jeton de confirmation émis pour un autre outil ou falsifié", async () => {
    const { appFetch } = setup();
    client = await connectClient(appFetch);
    const preview = parseResult(await client.callTool({ name: "create_lead", arguments: { data: { nom: "A" } } }));
    const other = await client.callTool({
      name: "create_client",
      arguments: { data: { nom: "A" }, confirmation_token: preview.confirmation_token },
    });
    expect(textOf(other)).toContain("invalide");
    const forged = await client.callTool({ name: "create_lead", arguments: { data: { nom: "A" }, confirmation_token: "abc.def.ghi" } });
    expect(textOf(forged)).toContain("invalide");
  });

  it("montre les valeurs actuelles avant une modification", async () => {
    const { appFetch, sam } = setup();
    client = await connectClient(appFetch);
    const args = { id: "c-1", data: { ville: "Marseille" } };
    const preview = parseResult(await client.callTool({ name: "update_client", arguments: args }));
    expect(preview.valeurs_actuelles).toEqual({ ville: "Lyon" });
    expect(sam.calls.some((c) => c.method === "PATCH")).toBe(false);
    const done = parseResult(await client.callTool({ name: "update_client", arguments: { ...args, confirmation_token: preview.confirmation_token } }));
    expect(done.item.ville).toBe("Marseille");
  });

  it("rattache un commentaire au client indiqué", async () => {
    const { appFetch, sam } = setup();
    client = await connectClient(appFetch);
    const args = { client_id: "c-2", data: { contenu: "Rappeler en janvier" } };
    const preview = parseResult(await client.callTool({ name: "add_client_comment", arguments: args }));
    expect(preview.changements).toEqual({ contenu: "Rappeler en janvier", client_id: "c-2" });
    await client.callTool({ name: "add_client_comment", arguments: { ...args, confirmation_token: preview.confirmation_token } });
    expect(sam.data.get("client-comments")?.at(-1)).toMatchObject({ client_id: "c-2", contenu: "Rappeler en janvier" });
  });
});

describe("schéma observé (format réel de l'API SAM)", () => {
  it("apprend les champs à partir des enregistrements réels", async () => {
    const { appFetch, sam } = setup({ mock: { schemaFormat: "names" } });
    client = await connectClient(appFetch);
    const schema = parseResult(await client.callTool({ name: "get_crm_schema", arguments: { entity: "clients" } }));
    const clients = schema.entities[0];
    expect(clients.source).toContain("observé");
    expect(clients.fields.map((f: any) => f.name)).toEqual(expect.arrayContaining(["nom", "ville", "statut"]));
    expect(clients.fields.find((f: any) => f.name === "id").read_only).toBe(true);
    expect(sam.calls.some((c) => c.method !== "GET" && c.path !== "/crm-api-auth")).toBe(false);
  });

  it("valide les écritures contre les champs observés", async () => {
    const { appFetch, sam } = setup({ mock: { schemaFormat: "names" } });
    client = await connectClient(appFetch);
    const bad = await client.callTool({ name: "update_client", arguments: { id: "c-1", data: { champ_invente: "x" } } });
    expect(textOf(bad)).toContain("champ_invente");
    const ok = parseResult(await client.callTool({ name: "update_client", arguments: { id: "c-1", data: { ville: "Nice" } } }));
    expect(ok.status).toBe("confirmation_requise");
    expect(sam.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("indique les entités sans champ connu", async () => {
    const { appFetch } = setup({ mock: { schemaFormat: "names" } });
    client = await connectClient(appFetch);
    const schema = parseResult(await client.callTool({ name: "get_crm_schema", arguments: {} }));
    expect(schema.entities).toHaveLength(12);
    expect(schema.entities.find((e: any) => e.entity === "products").note).toContain("Aucun champ connu");
  });
});

describe("commerciaux", () => {
  it("crée une fiche commercial après confirmation", async () => {
    const { appFetch, sam } = setup();
    client = await connectClient(appFetch);
    const args = { data: { nom: "Durand", prenom: "Léa", email: "lea@example.com", is_active: true } };
    const preview = parseResult(await client.callTool({ name: "create_commercial", arguments: args }));
    expect(preview.status).toBe("confirmation_requise");
    expect(sam.data.get("commerciaux")).toHaveLength(1);
    const done = parseResult(await client.callTool({ name: "create_commercial", arguments: { ...args, confirmation_token: preview.confirmation_token } }));
    expect(done.status).toBe("créé");
    expect(sam.data.get("commerciaux")).toHaveLength(2);
  });

  it("refuse de toucher au compte de connexion (user_id)", async () => {
    const { appFetch, sam } = setup({ env: { SAM_WRITE_MODE: "direct" } });
    client = await connectClient(appFetch);
    for (const [name, args] of [
      ["create_commercial", { data: { nom: "X", user_id: "u-999" } }],
      ["update_commercial", { id: "u-1", data: { user_id: "u-999" } }],
    ] as const) {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("compte de connexion");
    }
    expect(sam.calls.some((c) => c.method === "POST" || c.method === "PATCH")).toBe(false);
  });
});

describe("écritures en mode direct", () => {
  it("crée une tâche immédiatement", async () => {
    const { appFetch, sam } = setup({ env: { SAM_WRITE_MODE: "direct" } });
    client = await connectClient(appFetch);
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === "create_task")?.inputSchema.properties).not.toHaveProperty("confirmation_token");
    const res = parseResult(
      await client.callTool({ name: "create_task", arguments: { data: { titre: "Relancer Dupont", echeance: "2026-11-02", client_id: "c-1" } } }),
    );
    expect(res.status).toBe("créé");
    expect(sam.data.get("taches")).toHaveLength(1);
  });
});

describe("gestion des erreurs SAM", () => {
  it("signale une erreur serveur SAM sans planter", async () => {
    const { appFetch, sam } = setup();
    client = await connectClient(appFetch);
    sam.failNext("/crm-api/leads", 500, { error: "boom" });
    const res = await client.callTool({ name: "search_leads", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Erreur du serveur SAM");
  });

  it("signale un compte sans rôle SAM", async () => {
    const { appFetch } = setup({ mock: { hasSamRole: false } });
    client = await connectClient(appFetch);
    const res = await client.callTool({ name: "search_clients", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("rôle SAM");
  });

  it("refuse les écritures sur une entité sans champ connu (schéma non décrit, aucun enregistrement)", async () => {
    const { appFetch, sam } = setup({ mock: { schemaFormat: "names" } });
    client = await connectClient(appFetch);
    const res = await client.callTool({ name: "create_task", arguments: { data: { titre: "X" } } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Aucun champ connu");
    expect(sam.calls.some((c) => c.method === "POST" && c.path.startsWith("/crm-api/"))).toBe(false);
  });

  it("n'appelle jamais DELETE ni l'envoi d'email", async () => {
    const { appFetch, sam } = setup({ env: { SAM_WRITE_MODE: "direct" } });
    client = await connectClient(appFetch);
    for (const name of ["search_clients", "list_tasks", "list_notifications", "list_documents"]) {
      await client.callTool({ name, arguments: {} });
    }
    await client.callTool({ name: "update_task", arguments: { id: "x", data: { statut: "fait" } } });
    expect(sam.calls.some((c) => c.method === "DELETE" || c.path.includes("send-email"))).toBe(false);
  });
});
