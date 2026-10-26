/**
 * Read-only smoke test against a running server (local or deployed).
 *
 *   MCP_URL=https://sam-mcp.<sub>.workers.dev MCP_TOKEN=<SAM_ACCOUNT_N_STATIC_TOKEN> npm run smoke
 *
 * It only calls read tools (schema, search with limit=1): safe against the real SAM.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = (process.env.MCP_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const token = process.env.MCP_TOKEN ?? process.env.MCP_STATIC_TOKEN;

async function main() {
  const health = await fetch(`${base}/health`);
  console.log(`GET /health → ${health.status}`);

  const anon = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  console.log(`POST /mcp sans jeton → ${anon.status} (attendu 401), WWW-Authenticate: ${anon.headers.get("www-authenticate") ? "présent" : "absent"}`);

  const meta = await fetch(`${base}/.well-known/oauth-authorization-server`);
  console.log(`GET /.well-known/oauth-authorization-server → ${meta.status}`);

  if (!token) {
    console.log("MCP_TOKEN non défini : appels d'outils ignorés.");
    return;
  }
  const client = new Client({ name: "sam-smoke", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  const { tools } = await client.listTools();
  console.log(`tools/list → ${tools.length} outils : ${tools.map((t) => t.name).join(", ")}`);

  const schema = await client.callTool({ name: "get_crm_schema", arguments: {} });
  const schemaText = schema.content as { type: string; text: string }[];
  console.log(`get_crm_schema → ${schema.isError ? "ERREUR" : "ok"} : ${schemaText[0]?.text.slice(0, 300)}`);

  const search = await client.callTool({ name: "search_clients", arguments: { limit: 1, fields: undefined } });
  const searchText = search.content as { type: string; text: string }[];
  console.log(`search_clients(limit=1) → ${search.isError ? "ERREUR" : "ok"} : ${searchText[0]?.text.slice(0, 200)}`);
  await client.close();
}

main().catch((err) => {
  console.error("Échec :", err instanceof Error ? err.message : err);
  process.exit(1);
});
