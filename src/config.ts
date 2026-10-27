/** Write policy for tools that modify SAM data. */
export const WRITE_MODES = ["disabled", "confirm", "direct"] as const;
export type WriteMode = (typeof WRITE_MODES)[number];

export const DEFAULT_SAM_API_BASE_URL = "https://eicajdaswdgfwgmaxene.supabase.co/functions/v1";
export const DEFAULT_ALLOWED_REDIRECT_HOSTS = ["claude.ai", "claude.com", "localhost", "127.0.0.1"];
export const MAX_ACCOUNTS = 10;

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * One SAM account that can use the connector.
 * The person proves which account is theirs by typing `connectorPassword` on the
 * OAuth consent page (or by using `staticToken`); calls to SAM then use `email` / `password`.
 */
export interface AccountConfig {
  /** Stable id ("1", "2", …), used as the MCP principal. */
  id: string;
  /** Display name for logs and Claude's instructions (no secret). */
  label: string;
  email: string | undefined;
  password: string | undefined;
  connectorPassword: string;
  staticToken: string | undefined;
}

export interface Config {
  sam: {
    baseUrl: string;
    mock: boolean;
    timeoutMs: number;
    /** Enables the send_email tool (POST /send-email). Off by default. */
    sendEmail: boolean;
    /**
     * Public (anon) key of SAM's Supabase project, the one shipped in SAM's own web app.
     * Enables the features the CRM web app performs outside /crm-api (email templates and
     * history, file storage, account creation). Undefined = those tools are not exposed.
     */
    supabaseAnonKey: string | undefined;
  };
  accounts: AccountConfig[];
  writeMode: WriteMode;
  auth: {
    secret: string;
    publicUrl: string | undefined;
    allowedRedirectHosts: string[];
  };
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

const truthy = (v: string | undefined) => v !== undefined && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
const clean = (v: string | undefined) => (v === undefined || v.trim() === "" ? undefined : v.trim());
/** Passwords are kept verbatim (spaces are meaningful), but empty means unset. */
const raw = (v: string | undefined) => (v === undefined || v === "" ? undefined : v);

/** Every value that must never appear in logs. */
export function configSecrets(config: Config): string[] {
  const out = [config.auth.secret];
  if (config.sam.supabaseAnonKey) out.push(config.sam.supabaseAnonKey);
  for (const a of config.accounts) {
    for (const v of [a.password, a.connectorPassword, a.staticToken]) if (v) out.push(v);
  }
  return out;
}

function readAccounts(e: Record<string, string>, mock: boolean, problems: string[]): AccountConfig[] {
  const numbered: AccountConfig[] = [];
  const hasNumbered = Object.keys(e).some((k) => /^SAM_ACCOUNT_\d+_/.test(k) && clean(e[k]) !== undefined);
  const hasLegacy = [e.SAM_EMAIL, e.SAM_PASSWORD, e.MCP_OWNER_PASSWORD].some((v) => clean(v) !== undefined);

  if (hasNumbered && hasLegacy) {
    problems.push("Utiliser soit SAM_ACCOUNT_<N>_* (plusieurs comptes), soit SAM_EMAIL/SAM_PASSWORD/MCP_OWNER_PASSWORD (un compte), pas les deux");
    return [];
  }

  if (hasNumbered) {
    for (let n = 1; n <= MAX_ACCOUNTS; n++) {
      const p = `SAM_ACCOUNT_${n}_`;
      const email = clean(e[`${p}EMAIL`]);
      const password = raw(e[`${p}PASSWORD`]);
      const connectorPassword = raw(e[`${p}CONNECTOR_PASSWORD`]);
      const staticToken = clean(e[`${p}STATIC_TOKEN`]);
      if (!email && !password && !connectorPassword && !staticToken) continue;
      numbered.push({ id: String(n), label: clean(e[`${p}LABEL`]) ?? `Compte ${n}`, email, password, connectorPassword: connectorPassword ?? "", staticToken });
    }
  } else if (hasLegacy || mock) {
    numbered.push({
      id: "1",
      label: clean(e.SAM_LABEL) ?? "Compte 1",
      email: clean(e.SAM_EMAIL),
      password: raw(e.SAM_PASSWORD),
      connectorPassword: raw(e.MCP_OWNER_PASSWORD) ?? "",
      staticToken: clean(e.MCP_STATIC_TOKEN),
    });
  }

  if (numbered.length === 0) {
    problems.push("Aucun compte configuré : renseigner SAM_ACCOUNT_1_EMAIL, SAM_ACCOUNT_1_PASSWORD et SAM_ACCOUNT_1_CONNECTOR_PASSWORD");
    return [];
  }

  for (const a of numbered) {
    const name = hasNumbered ? `SAM_ACCOUNT_${a.id}_` : "";
    if (!mock && (!a.email || !a.password)) {
      problems.push(hasNumbered ? `${name}EMAIL et ${name}PASSWORD sont requis` : "SAM_EMAIL et SAM_PASSWORD sont requis (ou SAM_MOCK=true)");
    }
    if (a.connectorPassword.length < 12) {
      problems.push(`${hasNumbered ? `${name}CONNECTOR_PASSWORD` : "MCP_OWNER_PASSWORD"} doit contenir au moins 12 caractères`);
    }
    if (a.password && a.connectorPassword === a.password) {
      problems.push(`Le mot de passe du connecteur du compte ${a.id} doit être différent de son mot de passe SAM`);
    }
    if (a.staticToken !== undefined && a.staticToken.length < 32) {
      problems.push(`${hasNumbered ? `${name}STATIC_TOKEN` : "MCP_STATIC_TOKEN"} doit contenir au moins 32 caractères (ou être vide)`);
    }
  }
  const connectorPasswords = numbered.map((a) => a.connectorPassword).filter(Boolean);
  if (new Set(connectorPasswords).size !== connectorPasswords.length) {
    problems.push("Chaque compte doit avoir un mot de passe de connecteur différent (il sert à identifier le compte)");
  }
  const tokens = numbered.map((a) => a.staticToken).filter((t): t is string => Boolean(t));
  if (new Set(tokens).size !== tokens.length) problems.push("Chaque compte doit avoir un STATIC_TOKEN différent");
  return numbered;
}

/**
 * Builds and validates the configuration from an env-like record
 * (process.env on Node, the `env` binding on Cloudflare Workers).
 * Error messages name the variables but never include their values.
 */
export function loadConfig(env: Record<string, unknown>): Config {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") e[k] = v;
  const problems: string[] = [];
  const mock = truthy(e.SAM_MOCK);

  const baseUrl = (clean(e.SAM_API_BASE_URL) ?? DEFAULT_SAM_API_BASE_URL).replace(/\/+$/, "");
  if (!/^https:\/\//.test(baseUrl) && !mock) problems.push("SAM_API_BASE_URL doit être une URL https://");

  const accounts = readAccounts(e, mock, problems);

  const writeModeRaw = (clean(e.SAM_WRITE_MODE) ?? "confirm").toLowerCase();
  if (!(WRITE_MODES as readonly string[]).includes(writeModeRaw)) problems.push(`SAM_WRITE_MODE doit valoir ${WRITE_MODES.join(" | ")}`);

  const secret = e.MCP_AUTH_SECRET ?? "";
  if (secret.length < 32) problems.push("MCP_AUTH_SECRET doit contenir au moins 32 caractères");
  if (accounts.some((a) => a.staticToken === secret || a.connectorPassword === secret)) {
    problems.push("MCP_AUTH_SECRET doit être différent des mots de passe et jetons des comptes");
  }

  const publicUrl = clean(e.MCP_PUBLIC_URL)?.replace(/\/+$/, "");
  if (publicUrl !== undefined && !/^https?:\/\//.test(publicUrl)) problems.push("MCP_PUBLIC_URL doit être une URL http(s)://");

  const timeoutMs = Number(clean(e.SAM_REQUEST_TIMEOUT_MS) ?? "15000");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) problems.push("SAM_REQUEST_TIMEOUT_MS doit être compris entre 1000 et 60000");

  const logLevelRaw = (clean(e.LOG_LEVEL) ?? "info").toLowerCase();
  if (!["debug", "info", "warn", "error"].includes(logLevelRaw)) problems.push("LOG_LEVEL doit valoir debug | info | warn | error");

  if (problems.length > 0) throw new ConfigError(`Configuration invalide :\n- ${problems.join("\n- ")}`);

  const hosts = clean(e.OAUTH_ALLOWED_REDIRECT_HOSTS);
  return {
    sam: { baseUrl, mock, timeoutMs, sendEmail: truthy(e.SAM_SEND_EMAIL), supabaseAnonKey: clean(e.SAM_SUPABASE_ANON_KEY) },
    accounts,
    writeMode: writeModeRaw as WriteMode,
    auth: {
      secret,
      publicUrl,
      allowedRedirectHosts: hosts ? hosts.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean) : DEFAULT_ALLOWED_REDIRECT_HOSTS,
    },
    logLevel: logLevelRaw as LogLevel,
  };
}
