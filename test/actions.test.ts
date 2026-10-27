import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { parisNineAmIso } from "../src/mcp/actions.js";
import { connectClient, parseResult, setup, textOf } from "./helpers.js";

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
  vi.restoreAllMocks();
});

const WEB = { SAM_WRITE_MODE: "direct", SAM_SUPABASE_ANON_KEY: "anon-test-key", SAM_SEND_EMAIL: "true" };

function seed(sam: ReturnType<typeof setup>["sam"]) {
  sam.data.get("distributeurs")?.push({ id: "dist-1", nom: "Distrib Sud", nom_distributeur: "Distrib Sud", email: "contact@distrib.test" });
  sam.data.get("leads")?.push({ id: "l-2", nom: "Petit", prenom: "Anne", societe: "Petit SAS", email: "anne@example.com", telephone: "0600", distributeur_id: "dist-1", commercial_id: "u-1", statut: "a_cibler" });
  const c1 = sam.data.get("clients")?.find((c) => c.id === "c-1");
  if (c1) Object.assign(c1, { societe: "Dupont SARL", distributeur_id: "dist-1", commercial_id: "u-1" });
  const u1 = sam.data.get("commerciaux")?.find((c) => c.id === "u-1");
  if (u1) Object.assign(u1, { first_name: "Alice", last_name: "Durand", distributeur_id: "dist-1", user_id: null });
  sam.data.get("documents")?.push({ id: "d-1", client_id: "c-1", type_document: "attestation_urssaf", status: "manquant", file_url: null });
}

describe("outils exposés", () => {
  it("sans clé publique SAM, ni modèles, ni fichiers, ni comptes", async () => {
    const { appFetch } = setup({ env: { SAM_WRITE_MODE: "direct" } });
    client = await connectClient(appFetch);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["convert_lead", "set_reminder"]));
    for (const n of ["list_email_templates", "send_template_email", "create_upload_link", "create_commercial_account"]) expect(names).not.toContain(n);
  });

  it("avec la clé publique SAM, toutes les actions du CRM", async () => {
    const { appFetch } = setup({ env: WEB });
    client = await connectClient(appFetch);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_email_templates", "preview_template_email", "send_template_email", "create_upload_link", "create_commercial_account"]));
  });
});

describe("convert_lead (logique du bouton du CRM)", () => {
  it("crée le client avec les champs du prospect et marque le prospect converti", async () => {
    const { appFetch, sam } = setup({ env: WEB });
    seed(sam);
    client = await connectClient(appFetch);
    const res = parseResult(await client.callTool({ name: "convert_lead", arguments: { lead_id: "l-2" } }));
    expect(res.status).toBe("converti");
    const created = sam.data.get("clients")?.find((c) => c.converted_from_lead_id === "l-2");
    expect(created).toMatchObject({ nom: "Petit", prenom: "Anne", societe: "Petit SAS", distributeur_id: "dist-1", commercial_id: "u-1", is_lead_converti: true, accompagnement_carsat: true });
    const lead = sam.data.get("leads")?.find((l) => l.id === "l-2");
    expect(lead).toMatchObject({ statut: "converti", converted_to_client_id: created?.id, converted_by_user_id: "user-1" });
    expect(typeof lead?.converted_at).toBe("string");
  });

  it("exige un distributeur et refuse un prospect déjà converti", async () => {
    const { appFetch, sam } = setup({ env: WEB });
    seed(sam);
    client = await connectClient(appFetch);
    const noDist = await client.callTool({ name: "convert_lead", arguments: { lead_id: "l-1" } });
    expect(textOf(noDist)).toContain("Aucun distributeur");
    await client.callTool({ name: "convert_lead", arguments: { lead_id: "l-2" } });
    const again = await client.callTool({ name: "convert_lead", arguments: { lead_id: "l-2" } });
    expect(textOf(again)).toContain("déjà converti");
    expect(sam.data.get("clients")?.filter((c) => c.converted_from_lead_id === "l-2")).toHaveLength(1);
  });

  it("convertit en distributeur", async () => {
    const { appFetch, sam } = setup({ env: WEB });
    seed(sam);
    client = await connectClient(appFetch);
    await client.callTool({ name: "convert_lead", arguments: { lead_id: "l-2", cible: "distributeur" } });
    expect(sam.data.get("distributeurs")?.find((d) => d.nom_distributeur === "Petit SAS")).toMatchObject({ dirigeant_societe: "Anne Petit", statut: "actif", is_active: true });
    expect(sam.data.get("leads")?.find((l) => l.id === "l-2")?.converted_to_distributeur_id).toBeTruthy();
  });
});

describe("set_reminder", () => {
  it("enregistre 9 h, heure de Paris, comme le CRM", async () => {
    expect(parisNineAmIso("2026-11-02")).toBe("2026-11-02T08:00:00.000Z");
    expect(parisNineAmIso("2026-07-01")).toBe("2026-07-01T07:00:00.000Z");
    const { appFetch, sam } = setup({ env: WEB });
    client = await connectClient(appFetch);
    await client.callTool({ name: "set_reminder", arguments: { client_id: "c-1", date: "2026-11-02" } });
    expect(sam.data.get("clients")?.find((c) => c.id === "c-1")?.next_reminder_at).toBe("2026-11-02T08:00:00.000Z");
    await client.callTool({ name: "set_reminder", arguments: { client_id: "c-1", date: null } });
    expect(sam.data.get("clients")?.find((c) => c.id === "c-1")?.next_reminder_at).toBeNull();
  });
});

describe("modèles d'email du CRM", () => {
  it("liste les modèles actifs (sans les archivés)", async () => {
    const { appFetch, sam } = setup({ env: WEB });
    client = await connectClient(appFetch);
    const res = parseResult(await client.callTool({ name: "list_email_templates", arguments: {} }));
    expect(res.modeles.map((m: any) => m.id).sort()).toEqual(["t-1", "t-2", "t-4", "t-5"]);
    expect(res.modeles.find((m: any) => m.id === "t-2").pieces_jointes).toEqual(["static_pdf"]);
    expect(sam.calls.filter((c) => c.path.startsWith("/rest/v1/")).every((c) => c.authorized)).toBe(true);
  });

  it("remplit les variables comme le CRM, sans envoyer", async () => {
    const { appFetch, sam } = setup({ env: WEB });
    seed(sam);
    client = await connectClient(appFetch);
    const res = parseResult(await client.callTool({ name: "preview_template_email", arguments: { template_id: "t-1", entity_type: "client", entity_id: "c-1", cc_commercial: true } }));
    expect(res.objet).toBe("Pré-demande – Dupont SARL");
    expect(res.texte).toContain("Bonjour Marie,\nVotre dossier avance.\nArno Test");
    expect(res.texte).toContain("L'équipe SAM");
    expect(res.destinataires).toEqual(["marie.dupont@example.com"]);
    expect(res.copies).toEqual(["direction@sam.test", "alice@sam.test"]);
    expect(res.variables_manquantes).toEqual([]);
    expect(sam.sentEmails).toHaveLength(0);
  });

  it("envoie avec copies et pièce jointe du modèle, puis inscrit l'historique", async () => {
    const { appFetch, sam } = setup({ env: WEB });
    seed(sam);
    client = await connectClient(appFetch);
    const res = parseResult(await client.callTool({ name: "send_template_email", arguments: { template_id: "t-2", entity_type: "client", entity_id: "c-1" } }));
    expect(res.status).toBe("envoyé");
    expect(res.historique).toContain("inscrit");
    const sent = sam.sentEmails[0];
    expect(sent).toMatchObject({ to: ["marie.dupont@example.com"], subject: "Relance Dupont", cc: ["contact@distrib.test"], bcc: ["archive@sam.test"] });
    expect(sent?.attachments?.[0]?.filename).toBe("guide.pdf");
    const log = sam.tables.get("email_logs")?.[0];
    expect(log).toMatchObject({ entity_type: "client", entity_id: "c-1", email_template_id: "t-2", status: "sent", sent_by_user_id: "user-1", provider_message_id: "msg-1" });
  });

  it("refuse un envoi avec variables vides ou pièce jointe générée", async () => {
    const { appFetch, sam } = setup({ env: WEB });
    seed(sam);
    client = await connectClient(appFetch);
    const missing = await client.callTool({ name: "send_template_email", arguments: { template_id: "t-5", entity_type: "client", entity_id: "c-1" } });
    expect(textOf(missing)).toContain("{{client.siret}}");
    const generated = await client.callTool({ name: "send_template_email", arguments: { template_id: "t-4", entity_type: "client", entity_id: "c-1" } });
    expect(textOf(generated)).toContain("depuis le CRM");
    expect(sam.sentEmails).toHaveLength(0);
  });

  it("send_email libre : copies et historique de la fiche", async () => {
    const { appFetch, sam } = setup({ env: WEB });
    client = await connectClient(appFetch);
    const res = parseResult(
      await client.callTool({ name: "send_email", arguments: { to: "x@example.com", cc: ["alice@sam.test"], subject: "Test", html: "<p>Bonjour</p>", entity_type: "client", entity_id: "c-1" } }),
    );
    expect(res.historique).toContain("inscrit");
    expect(sam.sentEmails[0]).toMatchObject({ to: ["x@example.com"], cc: ["alice@sam.test"] });
    expect(sam.tables.get("email_logs")).toHaveLength(1);
  });
});

describe("dépôt de fichier par lien", () => {
  const pdf = () => new File([new Uint8Array([37, 80, 68, 70, 45, 49])], "attestation.pdf", { type: "application/pdf" });

  it("crée un lien à usage unique et range le fichier comme le CRM", async () => {
    const { appFetch, sam } = setup({ env: WEB });
    seed(sam);
    client = await connectClient(appFetch);
    const res = parseResult(await client.callTool({ name: "create_upload_link", arguments: { client_id: "c-1", type_document: "attestation_urssaf" } }));
    expect(res.lien).toMatch(/^https:\/\/mcp\.test\/upload\//);
    const page = await appFetch(res.lien);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("attestation_urssaf");
    const form = new FormData();
    form.set("file", pdf());
    const up = await appFetch(res.lien, { method: "POST", body: form });
    expect(up.status).toBe(200);
    expect(await up.text()).toContain("Document déposé");
    const [key] = [...sam.storage.keys()];
    expect(key).toMatch(/^documents\/c-1\/attestation_urssaf_\d+\.pdf$/);
    const doc = sam.data.get("documents")?.find((d) => d.id === "d-1");
    expect(doc).toMatchObject({ status: "en_revision", uploaded_by_user_id: "user-1" });
    expect(String(doc?.file_url)).toContain("/storage/v1/object/sign/documents/c-1/");
    const again = await appFetch(res.lien, { method: "POST", body: form });
    expect(again.status).toBe(410);
  });

  it("document personnalisé, formats refusés et lien falsifié", async () => {
    const { appFetch, sam } = setup({ env: WEB });
    seed(sam);
    client = await connectClient(appFetch);
    const res = parseResult(await client.callTool({ name: "create_upload_link", arguments: { client_id: "c-1", titre: "DUERP 2026" } }));
    const bad = new FormData();
    bad.set("file", new File(["MZ"], "virus.exe", { type: "application/octet-stream" }));
    expect((await appFetch(res.lien, { method: "POST", body: bad })).status).toBe(400);
    const ok = new FormData();
    ok.set("file", pdf());
    expect((await appFetch(res.lien, { method: "POST", body: ok })).status).toBe(200);
    expect(sam.data.get("documents")?.find((d) => d.type_document === "custom")).toMatchObject({ client_id: "c-1", remarks: "Document personnalisé: DUERP 2026", status: "en_revision" });
    expect((await appFetch("https://mcp.test/upload/abc.def.ghi")).status).toBe(410);
    const unknown = await client.callTool({ name: "create_upload_link", arguments: { client_id: "c-1", type_document: "rib" } });
    expect(textOf(unknown)).toContain("Types présents : attestation_urssaf");
  });
});

describe("comptes des commerciaux", () => {
  it("toujours une confirmation, puis compte créé et accès envoyés sans exposer le mot de passe", async () => {
    const lines: string[] = [];
    for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    const { appFetch, sam } = setup({ env: WEB });
    seed(sam);
    client = await connectClient(appFetch);
    const preview = parseResult(await client.callTool({ name: "create_commercial_account", arguments: { commercial_id: "u-1" } }));
    expect(preview.status).toBe("confirmation_requise");
    expect(sam.functionCalls).toHaveLength(0);
    const done = parseResult(await client.callTool({ name: "create_commercial_account", arguments: { commercial_id: "u-1", confirmation_token: preview.confirmation_token } }));
    expect(done).toMatchObject({ status: "compte_créé", identifiants_envoyes: true });
    expect(sam.functionCalls.map((c) => c.name)).toEqual(["create-user-account", "send-access-credentials-commercial"]);
    expect(sam.functionCalls[0]?.body).toMatchObject({ email: "alice@sam.test", role: "commercial", entityId: "u-1", firstName: "Alice", lastName: "Durand", distributeurId: "dist-1" });
    expect(JSON.stringify(done)).not.toMatch(/password|mot_de_passe/i);
    const again = await client.callTool({ name: "create_commercial_account", arguments: { commercial_id: "u-1" } });
    expect(textOf(again)).toContain("déjà un compte");
    expect(lines.join("\n")).not.toContain("alice@sam.test");
  });
});

describe("contournement du bug SAM sur les commentaires", () => {
  it("lit les commentaires comme le site quand l'API officielle échoue", async () => {
    const { appFetch, sam } = setup({ env: WEB });
    client = await connectClient(appFetch);
    sam.failNext("/crm-api/client-comments", 400, { error: "column client_comments.deleted_at does not exist" });
    const res = parseResult(await client.callTool({ name: "list_client_comments", arguments: { client_id: "c-1" } }));
    expect(res.items).toHaveLength(1);
    expect(res.items[0].content).toBe("Client satisfait.");
  });
});
