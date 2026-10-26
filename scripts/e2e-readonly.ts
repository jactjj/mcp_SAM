/**
 * End-to-end READ-ONLY test against a running server connected to the real SAM API.
 * Calls every read tool over MCP/HTTP for each account that has a STATIC_TOKEN in .env.
 * Prints statuses and counts only (no personal data). Never calls a write tool.
 *
 *   npm start   (other terminal)   then   npm run e2e
 *   MCP_URL=https://… npm run e2e  (deployed server)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { existsSync } from "node:fs";
import { loadConfig } from "../src/config.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const base = (process.env.MCP_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`).replace(/\/+$/, "");
const config = loadConfig(process.env);

const WRITE_PREFIXES = ["create_", "update_", "add_"];
let failures = 0;

const text = (r: unknown) => ((r as CallToolResult).content?.[0] as { text?: string } | undefined)?.text ?? "";
const summary = (r: unknown): string => {
  const res = r as CallToolResult;
  if (res.isError) return `ERREUR : ${text(r).slice(0, 160)}`;
  try {
    const b = JSON.parse(text(r));
    if (Array.isArray(b.items)) return `ok, ${b.returned} renvoyé(s)${b.total !== undefined ? ` / ${b.total} au total` : ""}`;
    if (b.item) return `ok, fiche avec ${Object.keys(b.item).length} champs`;
    if (b.entities) return `ok, ${b.entities.filter((e: { fields: unknown[] }) => e.fields.length > 0).length}/${b.entities.length} entités avec champs connus`;
    if (b.stats) return `ok, ${Object.keys(b.stats).join(", ")}`;
    return "ok";
  } catch {
    return "ok (texte)";
  }
};

async function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function run() {
  const anon = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const info = (await (await fetch(`${base}/`)).json()) as { write_mode?: string };
  const writeMode = info.write_mode ?? "inconnu";
  console.log(`Serveur ${base} (mode d'écriture : ${writeMode})`);
  await check("accès sans jeton refusé", anon.status === 401, `HTTP ${anon.status}`);
  const fake = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: "Bearer faux-jeton" }, body: "{}" });
  await check("faux jeton refusé", fake.status === 401, `HTTP ${fake.status}`);

  for (const acc of config.accounts) {
    if (!acc.staticToken) {
      console.log(`\n${acc.label} : pas de STATIC_TOKEN, ignoré`);
      continue;
    }
    console.log(`\n=== ${acc.label} (compte ${acc.id}) ===`);
    const client = new Client({ name: "sam-e2e", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${acc.staticToken}` } } }),
    );
    await check("compte annoncé à Claude", client.getInstructions()?.includes(acc.label) ?? false);
    const tools = (await client.listTools()).tools;
    const writeTools = tools.filter((t) => WRITE_PREFIXES.some((p) => t.name.startsWith(p)));
    console.log(`  ${tools.length} outils exposés (${writeTools.length} d'écriture, mode ${writeMode})`);
    if (writeMode === "disabled") await check("aucun outil d'écriture en lecture seule", writeTools.length === 0);
    else await check("les 12 outils d'écriture sont exposés", writeTools.length === 12);

    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      console.log(`  ${r.isError ? "✗" : "✓"} ${name}(${Object.keys(args).join(", ")}) → ${summary(r)}`);
      return r;
    };

    await call("get_crm_schema");
    await call("get_crm_stats");
    const clients = await call("search_clients", { limit: 3, fields: ["nom", "ville"] });
    const firstClient = JSON.parse(text(clients) || "{}").items?.[0];
    if (firstClient?.id) {
      await call("get_client", { id: firstClient.id });
      if (firstClient.nom) await call("search_clients", { search: firstClient.nom, limit: 5, fields: ["nom"] });
      if (firstClient.ville) await call("search_clients", { filters: [{ field: "ville", op: "eq", value: firstClient.ville }], limit: 5, fields: ["ville"] });
      await call("list_tasks", { filters: [{ field: "client_id", op: "eq", value: firstClient.id }], limit: 5, fields: ["titre", "statut"] });
      await call("list_client_comments", { client_id: firstClient.id, limit: 5 });
      await call("list_client_products", { client_id: firstClient.id, limit: 5 });
    }
    const leads = await call("search_leads", { limit: 3, fields: ["nom", "statut"] });
    const firstLead = JSON.parse(text(leads) || "{}").items?.[0];
    if (firstLead?.id) {
      await call("get_lead", { id: firstLead.id });
      await call("list_lead_comments", { lead_id: firstLead.id, limit: 5 });
    }
    for (const name of ["list_commerciaux", "list_distributeurs", "list_products", "list_tasks", "list_appointments", "list_documents", "list_notifications"]) {
      await call(name, { limit: 3 });
    }
    const invalid = await client.callTool({ name: "search_clients", arguments: { filters: [{ field: "champ_invente", value: "x" }] } });
    await check("filtre sur un champ inexistant refusé", invalid.isError === true);
    const missing = await client.callTool({ name: "get_client", arguments: { id: "00000000-0000-0000-0000-000000000000" } });
    await check("fiche inexistante → erreur propre", missing.isError === true, text(missing).slice(0, 80));
    await client.close();
  }
  console.log(failures === 0 ? "\nVérifications de sécurité : toutes OK" : `\n${failures} vérification(s) en échec`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error("Échec :", err instanceof Error ? err.message : err);
  process.exit(1);
});
