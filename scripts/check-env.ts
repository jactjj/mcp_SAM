/**
 * Checks `.env` without printing any secret: shows which fields are filled, then
 * validates the whole configuration.   npm run env:check
 */
import { existsSync } from "node:fs";
import { ConfigError, MAX_ACCOUNTS, loadConfig } from "../src/config.js";

if (!existsSync(".env")) {
  console.error("Fichier .env introuvable (cp .env.example .env).");
  process.exit(1);
}
process.loadEnvFile(".env");

const mask = (k: string, v: string | undefined) => {
  if (!v) return "VIDE";
  if (k === "LABEL") return v;
  if (k === "EMAIL") return v.replace(/^(.).*(@.*)$/, "$1***$2");
  return `rempli (${v.length} caractères)`;
};

for (let n = 1; n <= MAX_ACCOUNTS; n++) {
  const keys = ["LABEL", "EMAIL", "PASSWORD", "CONNECTOR_PASSWORD", "STATIC_TOKEN"];
  if (!keys.some((k) => process.env[`SAM_ACCOUNT_${n}_${k}`])) continue;
  console.log(`Compte ${n}`);
  for (const k of keys) console.log(`  ${k.padEnd(19)} ${mask(k, process.env[`SAM_ACCOUNT_${n}_${k}`])}`);
}

try {
  const c = loadConfig(process.env);
  console.log(`\nConfiguration valide : ${c.accounts.length} compte(s), API ${c.sam.mock ? "SIMULÉE" : "réelle"}, écriture = ${c.writeMode}`);
} catch (err) {
  console.error(`\n${err instanceof ConfigError ? err.message : "Configuration illisible"}`);
  process.exit(1);
}
