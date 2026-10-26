/**
 * Node.js entry point (local development, or hosting on Render / any Node host).
 * Reads configuration from process.env; `.env` is loaded if present (Node >= 20.12).
 */
import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";

if (existsSync(".env") && typeof process.loadEnvFile === "function") process.loadEnvFile(".env");

const env: Record<string, string | undefined> = { ...process.env };
if (env.SAM_MOCK === "true") {
  // Dev convenience: fixed non-secret defaults so the mock server starts without a .env.
  env.MCP_AUTH_SECRET ??= "dev-only-secret-change-me-0123456789abcdef";
  const numbered = Object.keys(env).some((k) => /^SAM_ACCOUNT_\d+_/.test(k) && env[k]);
  if (!numbered) env.MCP_OWNER_PASSWORD ??= "dev-password-123";
}

try {
  const config = loadConfig(env);
  const app = createApp({ config });
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "127.0.0.1" }, (info) => {
    console.log(JSON.stringify({ level: "info", msg: "server.started", url: `http://${info.address}:${info.port}`, mock: config.sam.mock }));
  });
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : "Échec du démarrage");
  process.exit(1);
}
