import type { Logger } from "../logger.js";
import type { FetchLike, SamTokenManager } from "./auth.js";
import { type Filter, type SamEntity, FIELD_NAME_PATTERN, RECORD_ID_PATTERN, RESERVED_QUERY_PARAMS, isSamEntity } from "./entities.js";
import { SamApiError, ValidationError, errorFromStatus } from "./errors.js";

export type SamRecord = Record<string, unknown>;

export interface ListParams {
  limit: number;
  offset: number;
  search?: string | undefined;
  filters?: Filter[] | undefined;
}

export interface ListResult {
  items: SamRecord[];
  total: number | undefined;
}

export interface SamClientOptions {
  baseUrl: string;
  fetch: FetchLike;
  tokens: SamTokenManager;
  logger: Logger;
  timeoutMs: number;
}

/**
 * Typed client for the SAM REST API.
 *
 * Only documented endpoints are implemented. No email sending in this version
 * (format of /send-email not verified yet).
 * Every call carries the SAM JWT of the configured account, so CRM-side permissions
 * (SAM role, row-level rules) apply unchanged.
 */
export class SamClient {
  constructor(private readonly opts: SamClientOptions) {}

  async list(entity: SamEntity, params: ListParams): Promise<ListResult> {
    const query = new URLSearchParams();
    query.set("limit", String(params.limit));
    query.set("offset", String(params.offset));
    if (params.search) query.set("search", params.search);
    for (const f of params.filters ?? []) appendFilter(query, f);
    const body = await this.request("GET", `/crm-api/${entityPath(entity)}?${query.toString()}`);
    return normalizeList(body, entity);
  }

  async get(entity: SamEntity, id: string): Promise<SamRecord> {
    const body = await this.request("GET", `/crm-api/${entityPath(entity)}/${recordPath(id)}`);
    return normalizeRecord(body);
  }

  async create(entity: SamEntity, data: SamRecord): Promise<SamRecord> {
    const body = await this.request("POST", `/crm-api/${entityPath(entity)}`, data);
    return normalizeRecord(body);
  }

  async update(entity: SamEntity, id: string, data: SamRecord): Promise<SamRecord> {
    const body = await this.request("PATCH", `/crm-api/${entityPath(entity)}/${recordPath(id)}`, data);
    return normalizeRecord(body);
  }

  /** Deletes one record. Only reachable through the delete_record tool, always after explicit confirmation. */
  async delete(entity: SamEntity, id: string): Promise<unknown> {
    return this.request("DELETE", `/crm-api/${entityPath(entity)}/${recordPath(id)}`);
  }

  async stats(): Promise<unknown> {
    return this.request("GET", "/crm-api/stats");
  }

  async schema(): Promise<unknown> {
    return this.request("GET", "/crm-api/schema");
  }

  /**
   * Performs an authenticated call. On 401 the cached JWT is dropped, the server logs in
   * again and retries exactly once; a second 401 is reported as an authentication error.
   */
  private async request(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, payload?: unknown): Promise<unknown> {
    const started = Date.now();
    let token = await this.opts.tokens.getToken();
    let res = await this.send(method, path, token, payload);
    if (res.status === 401) {
      await res.body?.cancel().catch(() => undefined);
      this.opts.logger.info("sam.request.reauth", { method, path: pathForLog(path) });
      this.opts.tokens.invalidate(token);
      token = await this.opts.tokens.getToken();
      res = await this.send(method, path, token, payload);
    }

    const text = await res.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    this.opts.logger.info("sam.request", {
      method,
      path: pathForLog(path),
      status: res.status,
      duration_ms: Date.now() - started,
    });

    if (!res.ok) {
      if (res.status === 401) this.opts.tokens.invalidate(token);
      throw errorFromStatus(res.status, body);
    }
    return body;
  }

  private async send(method: string, path: string, token: string, payload?: unknown): Promise<Response> {
    try {
      return await this.opts.fetch(`${this.opts.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      this.opts.logger.warn("sam.request.network_error", { method, path: pathForLog(path), timeout });
      throw new SamApiError(
        timeout ? "Délai dépassé lors de l'appel à l'API SAM" : "Impossible de joindre l'API SAM",
        0,
        timeout ? "timeout" : "network_error",
      );
    }
  }
}

function entityPath(entity: SamEntity): string {
  if (!isSamEntity(entity)) throw new ValidationError(`Entité SAM inconnue : ${String(entity)}`);
  return entity;
}

function recordPath(id: string): string {
  if (!RECORD_ID_PATTERN.test(id)) throw new ValidationError("Identifiant invalide (caractères autorisés : lettres, chiffres, - et _)");
  return encodeURIComponent(id);
}

export function appendFilter(query: URLSearchParams, f: Filter): void {
  if (!FIELD_NAME_PATTERN.test(f.field)) throw new ValidationError(`Nom de champ de filtre invalide : ${f.field}`);
  if (RESERVED_QUERY_PARAMS.has(f.field)) throw new ValidationError(`"${f.field}" est un paramètre réservé, pas un filtre`);
  if (f.op === "null") {
    query.append(f.field, "null");
    return;
  }
  if (f.value === undefined || f.value === "") throw new ValidationError(`Le filtre sur "${f.field}" nécessite une valeur`);
  const value = String(f.value);
  query.append(f.field, f.op === "eq" ? value : `${f.op}.${value}`);
}

/** Query strings may contain searched names: only the path is logged. */
function pathForLog(path: string): string {
  return path.split("?")[0] ?? path;
}

const LIST_KEYS = ["data", "items", "results", "records", "rows"];

/** Accepts the plausible list envelopes (array, {data: []}, {items: []}, {<entity>: []}). */
export function normalizeList(body: unknown, entity: string): ListResult {
  if (Array.isArray(body)) return { items: body.filter(isRecord), total: undefined };
  if (isRecord(body)) {
    const keys = [...LIST_KEYS, entity, entity.replace(/-/g, "_")];
    for (const key of keys) {
      const v = body[key];
      if (Array.isArray(v)) return { items: v.filter(isRecord), total: pickTotal(body) };
    }
  }
  throw new SamApiError("Format de liste inattendu renvoyé par SAM", 200, "invalid_response");
}

export function normalizeRecord(body: unknown): SamRecord {
  if (isRecord(body)) {
    const inner = body.data;
    if (isRecord(inner)) return inner;
    if (Array.isArray(inner) && inner.length === 1 && isRecord(inner[0])) return inner[0];
    return body;
  }
  if (Array.isArray(body) && body.length === 1 && isRecord(body[0])) return body[0];
  throw new SamApiError("Format d'enregistrement inattendu renvoyé par SAM", 200, "invalid_response");
}

function pickTotal(body: Record<string, unknown>): number | undefined {
  for (const key of ["count", "total", "total_count"]) {
    const v = body[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  const pagination = body.pagination;
  if (isRecord(pagination)) {
    for (const key of ["total", "count"]) {
      const v = pagination[key];
      if (typeof v === "number") return v;
    }
  }
  return undefined;
}

export function isRecord(v: unknown): v is SamRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
