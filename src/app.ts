import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { type Config, configSecrets } from "./config.js";
import { type Logger, createLogger } from "./logger.js";
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from "./mcp/server.js";
import type { SamSession, ToolContext } from "./mcp/tools.js";
import { createMockSam } from "./mock/sam-mock.js";
import { authenticateBearer, publicBaseUrl, registerOAuthRoutes, SCOPE } from "./oauth/routes.js";
import { type FetchLike, SamTokenManager } from "./sam/auth.js";
import { SamClient } from "./sam/client.js";
import { type CredentialsProvider, EnvCredentialsProvider } from "./sam/credentials.js";
import { SchemaRegistry } from "./sam/schema.js";
import { TokenSigner, UsedTokenRegistry } from "./security/signer.js";

export interface AppOptions {
  config: Config;
  /** fetch used to reach SAM (injected in tests). */
  samFetch?: FetchLike;
  credentials?: CredentialsProvider;
  logger?: Logger;
}

const MAX_MCP_BODY_BYTES = 256 * 1024;

export function createApp(opts: AppOptions) {
  const { config } = opts;
  const logger = opts.logger ?? createLogger(config.logLevel, configSecrets(config));

  let samFetch: FetchLike;
  let credentials: CredentialsProvider;
  if (opts.samFetch) {
    samFetch = opts.samFetch;
    credentials = opts.credentials ?? new EnvCredentialsProvider(config.accounts);
  } else if (config.sam.mock) {
    logger.warn("sam.mock.enabled", { note: "API SAM simulée : aucune donnée réelle" });
    // Each configured account gets its own simulated SAM user.
    const demo = config.accounts.map((a) => ({ ...a, email: `compte${a.id}@sam.test`, password: `demo-password-${a.id}` }));
    samFetch = createMockSam({ users: demo.map((a) => ({ email: a.email, password: a.password })) }).fetch;
    credentials = new EnvCredentialsProvider(demo);
  } else {
    samFetch = (input, init) => fetch(input, init);
    credentials = opts.credentials ?? new EnvCredentialsProvider(config.accounts);
  }
  const accountLabels = new Map(config.accounts.map((a) => [a.id, a.label]));

  const signer = new TokenSigner(config.auth.secret);
  const usedCodes = new UsedTokenRegistry();
  const usedConfirmations = new UsedTokenRegistry();

  // One token manager / client / schema cache per SAM account, shared across requests.
  const sessions = new Map<string, SamSession>();
  const samFor = async (principal: string): Promise<SamSession> => {
    const creds = await credentials.getCredentials(principal);
    let s = sessions.get(creds.accountId);
    if (!s) {
      const tokens = new SamTokenManager({
        baseUrl: config.sam.baseUrl,
        credentials: creds,
        fetch: samFetch,
        logger,
        timeoutMs: config.sam.timeoutMs,
      });
      const client = new SamClient({ baseUrl: config.sam.baseUrl, fetch: samFetch, tokens, logger, timeoutMs: config.sam.timeoutMs });
      s = { accountId: creds.accountId, client, schema: new SchemaRegistry(client, logger) };
      sessions.set(creds.accountId, s);
    }
    return s;
  };

  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "Accept", "Mcp-Protocol-Version", "Mcp-Session-Id", "Last-Event-ID"],
      exposeHeaders: ["WWW-Authenticate", "Mcp-Session-Id", "Mcp-Protocol-Version"],
      maxAge: 600,
    }),
  );

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  });

  app.get("/", (c) =>
    c.json({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      mcp_endpoint: `${publicBaseUrl(config, c)}/mcp`,
      write_mode: config.writeMode,
      accounts: config.accounts.length,
      ...(config.sam.mock ? { mock: true } : {}),
    }),
  );
  app.get("/health", (c) => c.json({ status: "ok" }));

  registerOAuthRoutes(app, { config, signer, usedCodes, logger });

  app.all("/mcp", async (c) => {
    const auth = await authenticateBearer(c.req.header("authorization"), config, signer);
    if (!auth) {
      const base = publicBaseUrl(config, c);
      logger.info("mcp.unauthorized", { has_header: c.req.header("authorization") !== undefined });
      return c.json({ error: "unauthorized", error_description: "Jeton d'accès MCP manquant ou invalide" }, 401, {
        "WWW-Authenticate": `Bearer realm="sam-mcp", resource_metadata="${base}/.well-known/oauth-protected-resource", scope="${SCOPE}"`,
      });
    }

    // Stateless Streamable HTTP: no server-initiated SSE stream, no sessions to terminate.
    if (c.req.method !== "POST") {
      return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Méthode non autorisée" }, id: null }, 405, { Allow: "POST" });
    }

    const ctx: ToolContext = {
      principal: auth.principal,
      accountLabel: accountLabels.get(auth.principal) ?? auth.principal,
      sam: () => samFor(auth.principal),
      writeMode: config.writeMode,
      signer,
      usedConfirmations,
      logger,
    };
    const server = createMcpServer(ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_MCP_BODY_BYTES,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw, {
        authInfo: {
          token: auth.token,
          clientId: auth.clientId,
          scopes: [SCOPE],
          ...(auth.expiresAt !== undefined ? { expiresAt: auth.expiresAt } : {}),
          extra: { principal: auth.principal },
        },
      });
    } catch (err) {
      logger.error("mcp.request_failed", { error: err });
      return c.json({ jsonrpc: "2.0", error: { code: -32603, message: "Erreur interne" }, id: null }, 500);
    } finally {
      // JSON response mode: the response is complete once handleRequest resolves.
      await server.close().catch(() => undefined);
    }
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    logger.error("http.unhandled", { error: err });
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
