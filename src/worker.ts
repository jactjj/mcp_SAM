/**
 * Cloudflare Workers entry point.
 * Variables come from wrangler.toml [vars]; secrets from `wrangler secret put`.
 *
 * The app (and with it the cached SAM JWT and schema) is kept for the life of the
 * isolate and rebuilt only if the configuration changes, so SAM is not asked for a
 * new token on every request.
 */
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";

type App = ReturnType<typeof createApp>;
let cached: { key: string; app: App } | undefined;

function configKey(env: Record<string, unknown>): string {
  return JSON.stringify(
    Object.entries(env)
      .filter(([, v]) => typeof v === "string")
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

export default {
  async fetch(request: Request, env: Record<string, unknown>, ctx: unknown): Promise<Response> {
    const key = configKey(env);
    if (!cached || cached.key !== key) {
      try {
        cached = { key, app: createApp({ config: loadConfig(env) }) };
      } catch (err) {
        // Names of the missing variables only; values are never printed.
        console.error(JSON.stringify({ level: "error", msg: "config.invalid", detail: err instanceof ConfigError ? err.message : "unknown" }));
        return new Response(JSON.stringify({ error: "server_misconfigured" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return cached.app.fetch(request, env, ctx as never);
  },
};
