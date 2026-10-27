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
  clients: [...base, f("nom", "text", true), f("prenom"), f("email"), f("telephone"), f("entreprise"), f("ville"), f("statut"), f("commercial_id", "uuid"),
    // Real SAM field names (observed 2026-10-26/27), used by the CRM actions.
    f("societe"), f("siret"), f("adresse"), f("code_postal"), f("telephone_2"), f("commentaire"), f("distributeur_id", "uuid"), f("converted_from_lead_id", "uuid"),
    f("is_lead_converti", "boolean"), f("accompagnement_carsat", "boolean"), f("next_reminder_at", "timestamptz"), f("statut_sam")],
  leads: [...base, f("nom", "text", true), f("prenom"), f("email"), f("telephone"), f("entreprise"), f("source"), f("statut"), f("score", "integer"),
    f("societe"), f("siret"), f("adresse"), f("code_postal"), f("ville"), f("telephone_2"), f("commentaire"), f("distributeur_id", "uuid"), f("commercial_id", "uuid"),
    f("converted_to_client_id", "uuid"), f("converted_to_distributeur_id", "uuid"), f("converted_at", "timestamptz"), f("converted_by_user_id", "uuid")],
  distributeurs: [...base, f("nom", "text", true), f("ville"), f("nom_distributeur"), f("dirigeant_societe"), f("email"), f("telephone"), f("siret"), f("adresse"),
    f("code_postal"), f("commentaire"), f("statut"), f("is_active", "boolean")],
  commerciaux: [...base, f("nom", "text", true), f("prenom"), f("email"), f("user_id", "uuid"), f("is_active", "boolean"), f("first_name"), f("last_name"), f("distributeur_id", "uuid")],
  taches: [...base, f("titre", "text", true), f("description"), f("statut"), f("echeance", "date"), f("client_id", "uuid"), f("lead_id", "uuid")],
  rdv: [...base, f("titre", "text", true), f("date_debut", "timestamptz", true), f("date_fin", "timestamptz"), f("lieu"), f("client_id", "uuid")],
  products: [...base, f("nom", "text", true), f("prix", "numeric"), f("reference")],
  documents: [...base, f("nom", "text", true), f("url"), f("client_id", "uuid"), f("type_document"), f("status"), f("file_url"), f("uploaded_by_user_id", "uuid"),
    f("date_mise_a_jour", "timestamptz"), f("distributeur_id", "uuid"), f("remarks")],
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
  sentEmails: { to: string | string[]; subject: string; html: string; cc?: string[]; bcc?: string[]; attachments?: { filename: string; content: string }[] }[];
  /** Tables reached like SAM's web app does (/rest/v1). */
  tables: Map<string, Rec[]>;
  /** Files in SAM storage (/storage/v1), by "bucket/path". */
  storage: Map<string, { size: number; contentType: string }>;
  /** Calls to SAM functions used by the web app (create-user-account…), passwords masked. */
  functionCalls: { name: string; body: Rec }[];
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
    tables: new Map<string, Rec[]>([
      [
        "email_templates",
        [
          { id: "t-1", name: "Pré-demande CARSAT", category: "documents", target_type: "client", status: "actif", subject_template: "Pré-demande – {{client.societe}}", body_template: "Bonjour {{client.prenom}},\nVotre dossier avance.\n{{sam.arno_nom}}", signature: "L'équipe {{sam.company_name}}", default_cc: ["direction@sam.test"], default_bcc: [] },
          { id: "t-2", name: "Relance distributeur", category: "relance", target_type: "client_et_distributeur", status: "actif", subject_template: "Relance {{client.nom}}", body_template: "<p>Bonjour {{client.prenom}}</p>", signature: null, default_cc: [], default_bcc: ["archive@sam.test"] },
          { id: "t-3", name: "Ancien modèle", category: "autre", target_type: "client", status: "archive", subject_template: "Ancien", body_template: "x", default_cc: [] },
          { id: "t-4", name: "Contrat généré", category: "devis", target_type: "client", status: "actif", subject_template: "Contrat {{client.nom}}", body_template: "Ci-joint", default_cc: [] },
          { id: "t-5", name: "Variable manquante", category: "autre", target_type: "client", status: "actif", subject_template: "Dossier {{client.siret}}", body_template: "x", default_cc: [] },
        ],
      ],
      [
        "email_template_attachments",
        [
          { id: "a-1", email_template_id: "t-2", attachment_type: "static_pdf", file_url: "https://sam.test/storage/v1/object/public/email-attachments/guide.pdf", filename_override: "guide.pdf", display_order: 1 },
          { id: "a-2", email_template_id: "t-4", attachment_type: "generated_pdf_template", document_template_id: "dt-1", display_order: 1 },
        ],
      ],
      ["sam_contact_info", [{ id: "s-1", company_name: "SAM", team_members: [{ name: "Arno Test", email: "arno@sam.test", phone: "0100" }, { name: "Lenny Test", email: "lenny@sam.test", phone: "0200" }] }]],
      ["client_comments", [{ id: "cc-1", client_id: "c-1", content: "Client satisfait.", created_at: new Date(0).toISOString() }]],
      ["lead_comments", []],
      ["notifications", []],
      ["email_logs", []],
    ]),
    storage: new Map(),
    functionCalls: [],
    expireAllTokens: () => tokens.clear(),
    failNext: (prefix, status, body) => failures.push({ prefix, status, body }),
    fetch: async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/functions\/v1/, "");
      const method = req.method.toUpperCase();
      const text = method === "GET" || method === "HEAD" ? "" : await req.text();
      let body: unknown = undefined;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined; // binary upload
      }
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
        mock.sentEmails.push({
          to: Array.isArray(b.to) ? (b.to as string[]) : String(b.to),
          subject: String(b.subject),
          html: String(b.html),
          ...(b.cc ? { cc: b.cc as string[] } : {}),
          ...(b.bcc ? { bcc: b.bcc as string[] } : {}),
          ...(b.attachments ? { attachments: b.attachments as { filename: string; content: string }[] } : {}),
        });
        return json(200, { id: `msg-${mock.sentEmails.length}` });
      }
      // --- Channels used by SAM's web app (read in its code on 2026-10-27) ---
      if (path.startsWith("/storage/v1/object/public/email-attachments/") && method === "GET") {
        return new Response("%PDF-1.4 mock", { status: 200, headers: { "Content-Type": "application/pdf" } });
      }
      if (path.startsWith("/rest/v1/") || path.startsWith("/storage/v1/") || path === "/create-user-account" || path === "/send-access-credentials-commercial") {
        if (!req.headers.get("apikey")) return json(401, { message: "No API key found in request" });
        if (!authorized) return json(401, { message: "JWT expired" });
      }
      if (path.startsWith("/rest/v1/")) {
        const table = path.slice("/rest/v1/".length);
        const rows = mock.tables.get(table);
        if (!rows) return json(404, { message: `relation "public.${table}" does not exist` });
        if (method === "POST") {
          const row = { id: `${table}-${rows.length + 1}`, created_at: new Date(now()).toISOString(), ...(body as Rec) };
          rows.push(row);
          return json(201, [row]);
        }
        let out = [...rows];
        for (const [k, raw] of url.searchParams) {
          if (["select", "order", "limit", "offset"].includes(k)) continue;
          const [op, ...rest] = raw.split(".");
          const v = rest.join(".");
          out = out.filter((r) => {
            const x = r[k];
            if (op === "eq") return String(x) === v;
            if (op === "neq") return String(x) !== v;
            if (op === "is") return x === null || x === undefined;
            if (op === "ilike") return String(x ?? "").toLowerCase().includes(v.replace(/\*/g, "").toLowerCase());
            if (op === "gte") return String(x) >= v;
            if (op === "lte") return String(x) <= v;
            return true;
          });
        }
        const off = Number(url.searchParams.get("offset") ?? 0);
        const lim = Number(url.searchParams.get("limit") ?? 1000);
        return json(200, out.slice(off, off + lim));
      }
      if (path.startsWith("/storage/v1/object/sign/") && method === "POST") {
        const key = path.slice("/storage/v1/object/sign/".length);
        if (!mock.storage.has(key)) return json(404, { message: "Object not found" });
        return json(200, { signedURL: `/object/sign/${key}?token=mock-signed` });
      }
      if (path.startsWith("/storage/v1/object/") && method === "POST") {
        const key = path.slice("/storage/v1/object/".length);
        if (mock.storage.has(key)) return json(409, { message: "The resource already exists" });
        mock.storage.set(key, { size: text.length, contentType: req.headers.get("content-type") ?? "" });
        return json(200, { Key: key });
      }
      if (path === "/create-user-account" && method === "POST") {
        const b = (body ?? {}) as Rec;
        mock.functionCalls.push({ name: "create-user-account", body: { ...b, password: b.password ? "***" : undefined } });
        if (!b.email || !b.password || !b.role || !b.entityId) return json(200, { error: "Missing fields" });
        const c = data.get("commerciaux")?.find((x) => x.id === b.entityId);
        if (c) c.user_id = `auth-${mock.functionCalls.length}`;
        return json(200, { success: true });
      }
      if (path === "/send-access-credentials-commercial" && method === "POST") {
        const b = (body ?? {}) as Rec;
        mock.functionCalls.push({ name: "send-access-credentials-commercial", body: { ...b, password: b.password ? "***" : undefined } });
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
