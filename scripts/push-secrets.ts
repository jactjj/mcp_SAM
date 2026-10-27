/**
 * Sends the secrets of `.env` to Cloudflare Workers in one go (`wrangler secret bulk`),
 * through stdin: no temporary file, nothing printed.
 *
 *   npx wrangler login      (once)
 *   npm run secrets:push
 *
 * Only secrets are sent (MCP_AUTH_SECRET, SAM_SUPABASE_ANON_KEY and SAM_ACCOUNT_<N>_*). Non-secret settings
 * (SAM_WRITE_MODE, SAM_API_BASE_URL, MCP_PUBLIC_URL…) live in wrangler.toml [vars].
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { ConfigError, loadConfig } from "../src/config.js";

if (!existsSync(".env")) {
  console.error("Fichier .env introuvable.");
  process.exit(1);
}
process.loadEnvFile(".env");

try {
  const config = loadConfig({ ...process.env, SAM_MOCK: "false" });
  if (config.accounts.length === 0) throw new ConfigError("Aucun compte");
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : "Configuration invalide");
  process.exit(1);
}

const secrets: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (!v) continue;
  if (k === "MCP_AUTH_SECRET" || k === "SAM_SUPABASE_ANON_KEY" || /^SAM_ACCOUNT_\d+_(LABEL|EMAIL|PASSWORD|CONNECTOR_PASSWORD|STATIC_TOKEN)$/.test(k)) secrets[k] = v;
}
console.log(`Envoi de ${Object.keys(secrets).length} secrets vers Cloudflare : ${Object.keys(secrets).sort().join(", ")}`);

const res = spawnSync("npx", ["wrangler", "secret", "bulk"], { input: JSON.stringify(secrets), stdio: ["pipe", "inherit", "inherit"] });
process.exit(res.status ?? 1);
