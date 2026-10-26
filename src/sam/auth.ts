import { z } from "zod";
import type { Logger } from "../logger.js";
import type { SamCredentials } from "./credentials.js";
import { SamApiError, errorFromStatus } from "./errors.js";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Shape of `POST /crm-api-auth` responses (documented fields only). */
const AuthResponseSchema = z.object({
  access_token: z.string().min(10),
  refresh_token: z.string().optional(),
  expires_in: z.number().positive().optional(),
  expires_at: z.number().positive().optional(),
  user: z.object({ id: z.string(), email: z.string().optional() }).passthrough().optional(),
});

/** Renew the JWT this many ms before its announced expiry. */
const EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_LIFETIME_MS = 3_600_000;

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

export interface TokenManagerOptions {
  baseUrl: string;
  credentials: SamCredentials;
  fetch: FetchLike;
  logger: Logger;
  timeoutMs: number;
  now?: () => number;
}

/**
 * Holds the SAM JWT for one account, server side only.
 * - logs in lazily, then reuses the token until shortly before `expires_at`;
 * - concurrent callers share a single in-flight login;
 * - `invalidate()` is called by the client after a 401 so the next call logs in again.
 */
export class SamTokenManager {
  private cached: CachedToken | undefined;
  private inflight: Promise<string> | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: TokenManagerOptions) {
    this.now = opts.now ?? Date.now;
  }

  async getToken(): Promise<string> {
    const c = this.cached;
    if (c && this.now() < c.expiresAtMs - EXPIRY_MARGIN_MS) return c.accessToken;
    if (!this.inflight) {
      this.inflight = this.login().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  invalidate(token?: string): void {
    if (token === undefined || this.cached?.accessToken === token) this.cached = undefined;
  }

  private async login(): Promise<string> {
    const { baseUrl, credentials, logger, timeoutMs } = this.opts;
    let res: Response;
    try {
      res = await this.opts.fetch(`${baseUrl}/crm-api-auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email: credentials.email, password: credentials.password }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      logger.error("sam.auth.network_error", { account: credentials.accountId, timeout });
      throw new SamApiError(
        timeout ? "Délai dépassé lors de l'authentification SAM" : "Impossible de joindre l'API SAM pour l'authentification",
        0,
        timeout ? "timeout" : "network_error",
      );
    }

    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      logger.warn("sam.auth.failed", { account: credentials.accountId, status: res.status });
      if (res.status === 400 || res.status === 401) {
        throw new SamApiError("Identifiants SAM refusés : vérifier SAM_EMAIL / SAM_PASSWORD côté serveur", res.status, "auth_failed");
      }
      throw errorFromStatus(res.status, body);
    }

    const parsed = AuthResponseSchema.safeParse(body);
    if (!parsed.success) {
      logger.error("sam.auth.invalid_response", { account: credentials.accountId });
      throw new SamApiError("Réponse d'authentification SAM inattendue", res.status, "invalid_response");
    }

    const now = this.now();
    const { access_token, expires_at, expires_in } = parsed.data;
    const expiresAtMs = expires_at ? expires_at * 1000 : now + (expires_in ? expires_in * 1000 : DEFAULT_LIFETIME_MS);
    this.cached = { accessToken: access_token, expiresAtMs };
    logger.info("sam.auth.ok", { account: credentials.accountId, expires_in_s: Math.round((expiresAtMs - now) / 1000) });
    return access_token;
  }
}
