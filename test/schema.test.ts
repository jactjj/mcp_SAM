import { describe, expect, it } from "vitest";
import { normalizeList, normalizeRecord } from "../src/sam/client.js";
import { inferFields, normalizeSchema } from "../src/sam/schema.js";
import { jsonResult, MAX_OUTPUT_CHARS, sanitizeRecord } from "../src/mcp/output.js";

describe("normalisation du schéma SAM", () => {
  it.each([
    ["{entities: {e: {fields: [..]}}}", { entities: { clients: { fields: [{ name: "nom", type: "text", required: true }] } } }],
    ["{e: [{column_name, data_type}]}", { clients: [{ column_name: "nom", data_type: "text", is_required: true }] }],
    ["{e: {columns: {nom: 'text'}}}", { clients: { columns: { nom: "text" } } }],
    ["{e: ['nom']}", { clients: ["nom"] }],
    ["[{table, columns}]", [{ table: "clients", columns: [{ name: "nom" }] }]],
    ["{data: {e: {properties: {nom: {type}}}}}", { data: { clients: { properties: { nom: { type: "string" } } } } }],
  ])("format %s", (_label, raw) => {
    const schema = normalizeSchema(raw);
    expect(schema.get("clients")?.fields.has("nom")).toBe(true);
  });

  it("associe les noms de tables avec underscore aux endpoints avec tiret", () => {
    const schema = normalizeSchema({ client_comments: ["client_id", "contenu"] });
    expect(schema.get("client-comments")?.fields.has("contenu")).toBe(true);
  });

  it("ignore les entités inconnues et les noms de champs invalides", () => {
    const schema = normalizeSchema({ users: ["email"], clients: ["ok_field", "bad field", "drop;table"] });
    expect(schema.has("clients")).toBe(true);
    expect([...(schema.get("clients")?.fields.keys() ?? [])]).toEqual(["ok_field"]);
    expect(schema.size).toBe(1);
  });

  it("renvoie un schéma vide pour un format inconnu", () => {
    expect(normalizeSchema({ hello: "world" }).size).toBe(0);
    expect(normalizeSchema(null).size).toBe(0);
  });
});

describe("champs observés", () => {
  it("déduit noms et types des enregistrements, sans inventer", () => {
    const f = inferFields([
      { id: "1", nom: "A", score: 3, actif: true, zones: [], commentaire: null, deleted_at: null },
      { id: "2", nom: "B", score: null, actif: false, zones: ["x"], commentaire: "ok", extra: 1 },
    ]);
    expect([...f.keys()].sort()).toEqual(["actif", "commentaire", "deleted_at", "extra", "id", "nom", "score", "zones"]);
    expect(f.get("score")?.type).toBe("number");
    expect(f.get("actif")?.type).toBe("boolean");
    expect(f.get("zones")?.type).toBe("array");
    expect(f.get("deleted_at")?.readOnly).toBe(true);
    expect(f.get("id")?.readOnly).toBe(true);
  });

  it("le format réel de /crm-api/schema (noms seuls) ne donne aucun champ déclaré", () => {
    expect(normalizeSchema({ entities: ["clients", "leads"], description: "CRM API" }).size).toBe(0);
  });

  it("lit le total dans pagination (format réel)", () => {
    expect(normalizeList({ data: [{ id: 1 }], pagination: { total: 215, limit: 1, offset: 0, has_more: true } }, "clients").total).toBe(215);
  });
});

describe("normalisation des réponses", () => {
  it("accepte plusieurs enveloppes de liste", () => {
    expect(normalizeList([{ id: 1 }], "clients").items).toHaveLength(1);
    expect(normalizeList({ data: [{ id: 1 }], count: 7 }, "clients")).toMatchObject({ total: 7 });
    expect(normalizeList({ clients: [{ id: 1 }] }, "clients").items).toHaveLength(1);
    expect(normalizeList({ client_products: [{ id: 1 }] }, "client-products").items).toHaveLength(1);
    expect(() => normalizeList({ foo: 1 }, "clients")).toThrow();
  });

  it("déballe un enregistrement", () => {
    expect(normalizeRecord({ data: { id: "a" } })).toEqual({ id: "a" });
    expect(normalizeRecord([{ id: "a" }])).toEqual({ id: "a" });
    expect(normalizeRecord({ id: "a" })).toEqual({ id: "a" });
  });
});

describe("limitation des données renvoyées", () => {
  it("retire les champs sensibles et tronque", () => {
    const out = sanitizeRecord({ id: "1", api_key: "k", password_hash: "h", bio: "x".repeat(1000), nested: { token: "t", ok: 1 } }, 100);
    expect(out).not.toHaveProperty("api_key");
    expect(out).not.toHaveProperty("password_hash");
    expect((out.bio as string).length).toBeLessThan(150);
    expect(out.nested).toEqual({ ok: 1 });
  });

  it("plafonne la taille totale d'une réponse", () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ id: i, text: "y".repeat(500) }));
    const res = jsonResult({ items });
    const first = res.content[0];
    expect(first?.type === "text" && first.text.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(first?.type === "text" && JSON.parse(first.text).truncated).toBe(true);
  });
});
