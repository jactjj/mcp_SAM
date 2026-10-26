/**
 * In-memory simulation of the SAM API, for tests and local development only.
 *
 * WARNING: the entity fields below are FICTIONAL examples chosen to exercise the code.
 * They do not describe the real SAM schema; production tools read the real fields
 * from `GET /crm-api/schema` at runtime.
 */
import type { FetchLike } from "../sam/auth.js";

type Rec = Record<string, unknown>;

interface MockField {
  name: string;
  type: string;
  required?: boolean;
}

const f = (name: string, type = "text", required = false): MockField => ({ name, type, required });
const base = [f("id", "uuid"), f("created_at", "timestamptz"), f("updated_at", "timestamptz")];

export const MOCK_SCHEMA: Record<string, MockField[]> = {
  clients: [...base, f("nom", "text", true), f("prenom"), f("email"), f("telephone"), f("entreprise"), f("ville"), f("statut"), f("commercial_id", "uuid")],
  leads: [...base, f("nom", "text", true), f("prenom"), f("email"), f("telephone"), f("entreprise"), f("source"), f("statut"), f("score", "integer")],
  distributeurs: [...base, f("nom", "text", true), f("ville")],
  commerciaux: [...base, f("nom", "text", true), f("prenom"), f("email"), f("user_id", "uuid"), f("is_active", "boolean")],
  taches: [...base, f("titre", "text", true), f("description"), f("statut"), f("echeance", "date"), f("client_id", "uuid"), f("lead_id", "uuid")],
  rdv: [...base, f("titre", "text", true), f("date_debut", "timestamptz", true), f("date_fin", "timestamptz"), f("lieu"), f("client_id", "uuid")],
  products: [...base, f("nom", "text", true), f("prix", "numeric"), f("reference")],
  documents: [...base, f("nom", "text", true), f("url"), f("client_id", "uuid")],
  "client-products": [...base, f("client_id", "uuid", true), f("product_id", "uuid", true), f("quantite", "integer")],
  "client-comments": [...base, f("client_id", "uuid", true), f("contenu", "text", true)],
  "lead-comments": [...base, f("lead_id", "uuid", true), f("contenu", "text", true)],
  notifications: [...base, f("titre", "text"), f("message"), f("lu", "boolean")],
};

export interface MockSamUser {
  email: string;
  password: string;
  /** false simulates an account without the SAM role (403 on every data call). */
  hasSamRole?: boolean;
}

export interface MockSamOptions {
  /** Accepted SAM accounts. Defaults to a single demo account. */
  users?: MockSamUser[];
  email?: string;
  password?: string;
  /** Lifetime of issued JWTs, in seconds (SAM: 3600). */
  tokenTtlSeconds?: number;
  /** Applies to the default single user: simulates an account without the SAM role. */
  hasSamRole?: boolean;
  now?: () => number;
  seed?: boolean;
  /**
   * "names" mimics the live SAM API (observed 2026-10-26): /crm-api/schema only lists entity
   * names, so fields must be learned from records. "fields" (default) describes fields.
   */
  schemaFormat?: "fields" | "names";
}

export interface MockSamCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
  authorized: boolean;
  /** Email of the SAM user owning the token, if valid. */
  user: string | undefined;
}

export interface MockSam {
  fetch: FetchLike;
  calls: MockSamCall[];
  logins: number;
  data: Map<string, Rec[]>;
  /** Invalidates every issued token (simulates server-side expiry). */
  expireAllTokens(): void;
  /** Overrides the next response for a path prefix (simulates SAM failures). */
  failNext(pathPrefix: string, status: number, body?: unknown): void;
  issuedTokens: string[];
  /** Emails accepted by the simulated /send-email. */
  sentEmails: { to: string; subject: string; html: string }[];
}

function randomToken(): string {
  const part = () => btoa(crypto.randomUUID()).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `eyJhbGciOiJIUzI1NiJ9.${part()}${part()}.${part()}`;
}

export function createMockSam(opts: MockSamOptions = {}): MockSam {
  const users: MockSamUser[] = opts.users ?? [
    { email: opts.email ?? "demo@sam.test", password: opts.password ?? "demo-password", hasSamRole: opts.hasSamRole },
  ];
  const ttl = opts.tokenTtlSeconds ?? 3600;
  const now = opts.now ?? Date.now;
  const tokens = new Map<string, { exp: number; user: MockSamUser }>();
  const failures: { prefix: string; status: number; body?: unknown }[] = [];
  const data = new Map<string, Rec[]>();
  for (const e of Object.keys(MOCK_SCHEMA)) data.set(e, []);

  if (opts.seed !== false) {
    const ts = new Date(0).toISOString();
    data.get("clients")?.push(
      { id: "c-1", nom: "Dupont", prenom: "Marie", email: "marie.dupont@example.com", entreprise: "Dupont SARL", ville: "Lyon", statut: "actif", created_at: ts, updated_at: ts },
      { id: "c-2", nom: "Martin", prenom: "Paul", email: "paul.martin@example.com", entreprise: "Martin & Fils", ville: "Paris", statut: "inactif", created_at: ts, updated_at: ts },
      { id: "c-3", nom: "Dupontel", prenom: "Luc", email: "luc@example.com", entreprise: "LD Conseil", ville: "Lyon", statut: "actif", notes: "x".repeat(5000), password_hash: "should-never-leak", created_at: ts, updated_at: ts },
    );
    data.get("leads")?.push({ id: "l-1", nom: "Bernard", entreprise: "Bernard SAS", statut: "nouveau", score: 40, created_at: ts, updated_at: ts });
    data.get("commerciaux")?.push({ id: "u-1", nom: "Durand", prenom: "Alice", email: "alice@sam.test" });
    data.get("client-comments")?.push({ id: "cc-1", client_id: "c-1", contenu: "Client satisfait.", created_at: ts });
  }

  const mock: MockSam = {
    calls: [],
    logins: 0,
    data,
    issuedTokens: [],
    sentEmails: [],
    expireAllTokens: () => tokens.clear(),
    failNext: (prefix, status, body) => failures.push({ prefix, status, body }),
    fetch: async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/functions\/v1/, "");
      const method = req.method.toUpperCase();
      const text = method === "GET" || method === "HEAD" ? "" : await req.text();
      const body: unknown = text ? JSON.parse(text) : undefined;
      const auth = req.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const session = tokens.get(token);
      const authorized = session !== undefined && session.exp > now();
      mock.calls.push({
        method,
        path,
        query: Object.fromEntries(url.searchParams),
        body,
        authorized,
        user: authorized ? session?.user.email : undefined,
      });
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

      const failure = failures.findIndex((x) => path.startsWith(x.prefix));
      if (failure >= 0) {
        const [fl] = failures.splice(failure, 1);
        if (fl) return json(fl.status, fl.body ?? { error: "Erreur simulée" });
      }

      if (path === "/crm-api-auth" && method === "POST") {
        const b = (body ?? {}) as Rec;
        const user = users.find((u) => u.email === b.email && u.password === b.password);
        if (!user) return json(400, { error: "Invalid login credentials" });
        mock.logins++;
        const t = randomToken();
        const expiresAt = now() + ttl * 1000;
        tokens.set(t, { exp: expiresAt, user });
        mock.issuedTokens.push(t);
        return json(200, {
          access_token: t,
          refresh_token: "mock-refresh-" + crypto.randomUUID(),
          expires_in: ttl,
          expires_at: Math.floor(expiresAt / 1000),
          user: { id: `user-${users.indexOf(user) + 1}`, email: user.email },
        });
      }

      if (path === "/send-email" && method === "POST") {
        if (!authorized) return json(401, { error: "Non autorisé" });
        const b = (body ?? {}) as Rec;
        const missing = ["to", "subject", "html"].filter((k) => !b[k]);
        // Same message as the live API (observed 2026-10-26).
        if (missing.length) return json(400, { error: `Missing required fields: ${missing.join(", ")}` });
        mock.sentEmails.push({ to: String(b.to), subject: String(b.subject), html: String(b.html) });
        return json(200, { success: true });
      }
      if (!path.startsWith("/crm-api")) return json(404, { error: "Not found" });
      if (!token) return json(401, { error: "Non autorisé - Token manquant" });
      if (!authorized) return json(401, { error: "Token invalide ou expiré" });
      if (session?.user.hasSamRole === false) return json(403, { error: "Accès réservé au rôle SAM" });

      const parts = path.split("/").filter(Boolean); // ["crm-api", entity, id?]
      const entity = parts[1];
      const id = parts[2];

      if (entity === "schema" && method === "GET" && opts.schemaFormat === "names") {
        return json(200, { entities: Object.keys(MOCK_SCHEMA), description: "CRM API - Use GET/POST/PATCH/DELETE on each entity" });
      }
      if (entity === "schema" && method === "GET") {
        return json(200, { entities: Object.fromEntries(Object.entries(MOCK_SCHEMA).map(([k, v]) => [k, { fields: v }])) });
      }
      if (entity === "stats" && method === "GET") {
        return json(200, { data: { clients: data.get("clients")?.length ?? 0, leads: data.get("leads")?.length ?? 0, taches: data.get("taches")?.length ?? 0 } });
      }
      if (!entity || !data.has(entity)) return json(404, { error: `Entité inconnue: ${entity}` });
      const rows = data.get(entity) as Rec[];
      const known = new Set((MOCK_SCHEMA[entity] ?? []).map((x) => x.name));

      if (method === "GET" && !id) {
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const search = url.searchParams.get("search")?.toLowerCase();
        let result = rows.filter((r) => !search || Object.values(r).some((v) => typeof v === "string" && v.toLowerCase().includes(search)));
        for (const [k, raw] of url.searchParams) {
          if (["limit", "offset", "search"].includes(k)) continue;
          if (!known.has(k)) return json(400, { error: `Colonne inconnue: ${k}` });
          result = result.filter((r) => {
            const v = r[k];
            if (raw === "null") return v === null || v === undefined;
            const [op, ...rest] = raw.includes(".") ? raw.split(".") : ["eq", raw];
            const val = rest.join(".");
            if (op === "not") return String(v) !== val;
            if (op === "gte") return String(v) >= val;
            if (op === "lte") return String(v) <= val;
            if (op === "like") return String(v ?? "").toLowerCase().includes(val.replace(/%/g, "").toLowerCase());
            return String(v) === raw;
          });
        }
        // Same envelope as the live API.
        return json(200, {
          data: result.slice(offset, offset + limit),
          pagination: { total: result.length, limit, offset, has_more: offset + limit < result.length },
        });
      }
      if (method === "GET" && id) {
        const r = rows.find((x) => x.id === id);
        return r ? json(200, { data: r }) : json(404, { error: "Enregistrement introuvable" });
      }
      if (method === "POST" && !id) {
        const b = (body ?? {}) as Rec;
        const unknown = Object.keys(b).filter((k) => !known.has(k));
        if (unknown.length) return json(400, { error: `Colonne inconnue: ${unknown.join(",")}` });
        const ts = new Date(now()).toISOString();
        const rec = { id: `${entity}-${rows.length + 1}`, ...b, created_at: ts, updated_at: ts };
        rows.push(rec);
        return json(201, { data: rec });
      }
      if (method === "PATCH" && id) {
        const r = rows.find((x) => x.id === id);
        if (!r) return json(404, { error: "Enregistrement introuvable" });
        Object.assign(r, body as Rec, { updated_at: new Date(now()).toISOString() });
        return json(200, { data: r });
      }
      if (method === "DELETE" && id) {
        const i = rows.findIndex((x) => x.id === id);
        if (i >= 0) rows.splice(i, 1);
        return json(200, { success: true });
      }
      return json(405, { error: "Méthode non supportée" });
    },
  };
  return mock;
}
