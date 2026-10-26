/**
 * Reads the REAL SAM schema (GET /crm-api/schema only: no write) and shows how the
 * connector understands it. Run it once real credentials are in `.env`:
 *
 *   npm run schema:fetch                 # summary, with account 1
 *   npm run schema:fetch -- --account=2  # with another configured account
 *   npm run schema:fetch -- --save       # also writes docs/sam-schema.snapshot.json
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { ConfigError, configSecrets, loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { SamTokenManager } from "../src/sam/auth.js";
import { SamClient } from "../src/sam/client.js";
import { SAM_ENTITIES } from "../src/sam/entities.js";
import { normalizeSchema } from "../src/sam/schema.js";

if (existsSync(".env") && typeof process.loadEnvFile === "function") process.loadEnvFile(".env");

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : "Configuration illisible");
  process.exit(1);
}
const accountId = process.argv.find((a) => a.startsWith("--account="))?.split("=")[1] ?? config.accounts[0]?.id;
const account = config.accounts.find((a) => a.id === accountId);
if (!account?.email || !account.password || config.sam.mock) {
  console.error(`Compte ${accountId} introuvable ou incomplet, ou SAM_MOCK=true.`);
  process.exit(1);
}
const baseUrl = config.sam.baseUrl;
const logger = createLogger("warn", configSecrets(config));
console.log(`Compte utilisé : ${account.label} (id ${account.id})`);
const tokens = new SamTokenManager({
  baseUrl,
  credentials: { accountId: account.id, label: account.label, email: account.email, password: account.password },
  fetch: (i, init) => fetch(i, init),
  logger,
  timeoutMs: 15000,
});
const client = new SamClient({ baseUrl, fetch: (i, init) => fetch(i, init), tokens, logger, timeoutMs: 15000 });

const raw = await client.schema();
const schema = normalizeSchema(raw);
console.log(`Entités reconnues : ${schema.size}/${SAM_ENTITIES.length}`);
for (const e of SAM_ENTITIES) {
  const es = schema.get(e);
  console.log(`- ${e}: ${es ? [...es.fields.values()].map((f) => `${f.name}${f.type ? `:${f.type}` : ""}${f.required ? "*" : ""}`).join(", ") : "NON RECONNUE"}`);
}
if (schema.size === 0) {
  console.log("\nFormat non reconnu. Extrait brut :\n" + JSON.stringify(raw, null, 2).slice(0, 4000));
}
if (process.argv.includes("--save")) {
  mkdirSync("docs", { recursive: true });
  writeFileSync("docs/sam-schema.snapshot.json", JSON.stringify(raw, null, 2) + "\n");
  console.log("\nSchéma brut enregistré dans docs/sam-schema.snapshot.json");
}
