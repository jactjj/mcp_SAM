import type { Logger } from "../logger.js";
import type { FetchLike, SamTokenManager } from "./auth.js";
import { SamApiError, ValidationError, errorFromStatus } from "./errors.js";

/**
 * Access to SAM through the same channels as SAM's own web app (https://sam.classicall.fr),
 * for the features /crm-api does not offer. Agreed with SAM (2026-10-27).
 *
 * Everything runs with the JWT of the connected SAM user, so SAM's row-level rules apply
 * exactly as in the web app. The allow-lists below are closed on purpose: only the tables,
 * buckets and functions the web app uses for these features are reachable.
 */
export const DIRECT_READ_TABLES = ["email_templates", "email_template_attachments", "sam_contact_info", "client_comments", "lead_comments", "notifications"] as const;
export const DIRECT_INSERT_TABLES = ["email_logs"] as const;
export const DIRECT_BUCKETS = ["documents"] as const;
export const DIRECT_FUNCTIONS = ["create-user-account", "send-access-credentials-commercial"] as const;

type ReadTable = (typeof DIRECT_READ_TABLES)[number];
type InsertTable = (typeof DIRECT_INSERT_TABLES)[number];
type Bucket = (typeof DIRECT_BUCKETS)[number];
type DirectFunction = (typeof DIRECT_FUNCTIONS)[number];

export interface SamDirectOptions {
  /** Supabase project root, e.g. https://<ref>.supabase.co */
  root: string;
  anonKey: string;
  fetch: FetchLike;
  tokens: SamTokenManager;
  logger: Logger;
  timeoutMs: number;
}

const STORAGE_PATH = /^[0-9A-Za-z_-]{1,64}\/[0-9A-Za-z_.-]{1,200}$/;

export class SamDirect {
  constructor(private readonly opts: SamDirectOptions) {}

  /** PostgREST select. `query` uses PostgREST syntax (select, field=eq.value, order, limit, offset). */
  async select(table: ReadTable, query: URLSearchParams): Promise<Record<string, unknown>[]> {
    const body = await this.call("GET", `/rest/v1/${table}?${query.toString()}`, undefined, { Accept: "application/json" });
    if (!Array.isArray(body)) throw new SamApiError("Réponse inattendue de SAM", 200, "invalid_response");
    return body as Record<string, unknown>[];
  }

  async insert(table: InsertTable, row: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const body = await this.call("POST", `/rest/v1/${table}`, JSON.stringify(row), {
      "Content-Type": "application/json",
      Prefer: "return=representation",
    });
    return Array.isArray(body) ? (body[0] as Record<string, unknown> | undefined) : undefined;
  }

  /** Uploads a file to a storage bucket (same options as the web app). */
  async upload(bucket: Bucket, path: string, bytes: ArrayBuffer, contentType: string): Promise<void> {
    if (!STORAGE_PATH.test(path)) throw new ValidationError("Chemin de fichier invalide");
    await this.call("POST", `/storage/v1/object/${bucket}/${path}`, bytes, {
      "Content-Type": contentType,
      "Cache-Control": "max-age=3600",
      "x-upsert": "false",
    });
  }

  /** Signed URL valid `expiresInSeconds` (the web app uses one year). */
  async signedUrl(bucket: Bucket, path: string, expiresInSeconds: number): Promise<string> {
    if (!STORAGE_PATH.test(path)) throw new ValidationError("Chemin de fichier invalide");
    const body = (await this.call("POST", `/storage/v1/object/sign/${bucket}/${path}`, JSON.stringify({ expiresIn: expiresInSeconds }), {
      "Content-Type": "application/json",
    })) as { signedURL?: string; signedUrl?: string } | undefined;
    const rel = body?.signedURL ?? body?.signedUrl;
    if (!rel) throw new SamApiError("SAM n'a pas renvoyé de lien vers le fichier", 200, "invalid_response");
    return rel.startsWith("http") ? rel : `${this.opts.root}/storage/v1${rel.startsWith("/") ? "" : "/"}${rel}`;
  }

  /** Downloads a file stored in SAM's storage (template attachments). Other hosts are refused. */
  async downloadStorageFile(url: string, maxBytes: number): Promise<Uint8Array> {
    if (!url.startsWith(`${this.opts.root}/storage/v1/object/`)) throw new ValidationError("Pièce jointe hors du stockage SAM : refusée");
    let res: Response;
    try {
      res = await this.opts.fetch(url, { headers: { apikey: this.opts.anonKey }, signal: AbortSignal.timeout(this.opts.timeoutMs * 2) });
    } catch {
      throw new SamApiError("Impossible de télécharger la pièce jointe du modèle", 0, "network_error");
    }
    if (!res.ok) throw new SamApiError("Pièce jointe du modèle introuvable", res.status, "not_found");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new ValidationError("Pièce jointe du modèle trop volumineuse");
    return bytes;
  }

  /** Edge function used by the web app. Errors returned in the body ({error}) are raised. */
  async invoke(name: DirectFunction, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body = await this.call("POST", `/functions/v1/${name}`, JSON.stringify(payload), { "Content-Type": "application/json" });
    const obj = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    if (typeof obj.error === "string" && obj.error) throw new SamApiError(`Refus de SAM : ${obj.error.slice(0, 300)}`, 400, "bad_request");
    return obj;
  }

  private async call(method: string, path: string, body: BodyInit | undefined, headers: Record<string, string>): Promise<unknown> {
    const started = Date.now();
    let token = await this.opts.tokens.getToken();
    let res = await this.send(method, path, body, headers, token);
    if (res.status === 401) {
      await res.body?.cancel().catch(() => undefined);
      this.opts.tokens.invalidate(token);
      token = await this.opts.tokens.getToken();
      res = await this.send(method, path, body, headers, token);
    }
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    // Only the route kind is logged (no ids, file names or query values).
    this.opts.logger.info("sam.direct", { method, kind: path.split("/").slice(0, 4).join("/"), status: res.status, duration_ms: Date.now() - started });
    if (!res.ok) throw errorFromStatus(res.status, parsed);
    return parsed;
  }

  private async send(method: string, path: string, body: BodyInit | undefined, headers: Record<string, string>, token: string): Promise<Response> {
    try {
      return await this.opts.fetch(`${this.opts.root}${path}`, {
        method,
        headers: { apikey: this.opts.anonKey, Authorization: `Bearer ${token}`, ...headers },
        body,
        signal: AbortSignal.timeout(this.opts.timeoutMs * 2),
      });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new SamApiError(timeout ? "Délai dépassé lors de l'appel à SAM" : "Impossible de joindre SAM", 0, timeout ? "timeout" : "network_error");
    }
  }
}

/** Supabase project root derived from SAM_API_BASE_URL (…/functions/v1). */
export function supabaseRoot(baseUrl: string): string {
  return baseUrl.replace(/\/functions\/v1\/?$/, "");
}
