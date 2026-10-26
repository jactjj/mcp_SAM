import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { WriteMode } from "../config.js";
import type { Logger } from "../logger.js";
import type { SamClient } from "../sam/client.js";
import { type Filter, type SamEntity, FIELD_NAME_PATTERN, FILTER_OPERATORS, RECORD_ID_PATTERN, SAM_ENTITIES } from "../sam/entities.js";
import { SamApiError, ValidationError } from "../sam/errors.js";
import { type FieldValue, type SchemaRegistry, SERVER_MANAGED_FIELDS } from "../sam/schema.js";
import { type TokenSigner, type UsedTokenRegistry, canonicalJson, sha256Base64Url } from "../security/signer.js";
import { DETAIL_MAX_STRING, LIST_MAX_STRING, errorResult, jsonResult, sanitizeRecord } from "./output.js";

export interface SamSession {
  accountId: string;
  client: SamClient;
  schema: SchemaRegistry;
}

export interface ToolContext {
  /** MCP principal = id of the SAM account (`sub` of the access token). */
  principal: string;
  /** Display name of that account. */
  accountLabel: string;
  sam: () => Promise<SamSession>;
  writeMode: WriteMode;
  signer: TokenSigner;
  usedConfirmations: UsedTokenRegistry;
  logger: Logger;
}

export const CONFIRMATION_TTL_SECONDS = 600;

// ---------------------------------------------------------------------------
// Shared input schemas
// ---------------------------------------------------------------------------

const fieldName = z.string().regex(FIELD_NAME_PATTERN, "Nom de champ invalide");
const recordId = z.string().regex(RECORD_ID_PATTERN, "Identifiant invalide").describe("Identifiant SAM de l'enregistrement");

const listShape = {
  search: z.string().trim().min(1).max(100).optional().describe("Recherche texte libre (paramètre `search` de l'API SAM)"),
  filters: z
    .array(
      z.object({
        field: fieldName.describe("Nom exact du champ (voir get_crm_schema)"),
        op: z.enum(FILTER_OPERATORS).default("eq").describe("eq (égal), not (différent), gte (≥), lte (≤), like (contient), null (vide)"),
        value: z.union([z.string().max(200), z.number(), z.boolean()]).optional().describe("Valeur (inutile pour op=null)"),
      }),
    )
    .max(10)
    .optional()
    .describe("Filtres exacts sur des champs existants"),
  fields: z.array(fieldName).min(1).max(30).optional().describe("Ne renvoyer que ces champs (réduit la taille de la réponse)"),
  limit: z.number().int().min(1).max(50).default(20).describe("Nombre maximum de résultats (1-50, défaut 20)"),
  offset: z.number().int().min(0).max(10_000).default(0).describe("Décalage pour la pagination"),
};

const fieldValue = z.union([
  z.string().max(5000),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string().max(500), z.number()])).max(50),
]);

const dataSchema = z
  .record(fieldName, fieldValue)
  .refine((d) => Object.keys(d).length > 0, "Au moins un champ est requis")
  .refine((d) => Object.keys(d).length <= 40, "40 champs maximum")
  .describe("Champs à enregistrer, avec leurs noms exacts issus de get_crm_schema");

const confirmationToken = z
  .string()
  .max(4096)
  .optional()
  .describe("Jeton renvoyé par l'aperçu. À fournir UNIQUEMENT après accord explicite de l'utilisateur.");

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const UPDATE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

async function run(ctx: ToolContext, tool: string, fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  const started = Date.now();
  try {
    const result = await fn();
    ctx.logger.info("tool.call", { tool, account: ctx.principal, ok: !result.isError, duration_ms: Date.now() - started });
    return result;
  } catch (err) {
    if (err instanceof ValidationError) {
      ctx.logger.info("tool.call", { tool, ok: false, reason: "validation", duration_ms: Date.now() - started });
      return errorResult(`Paramètres invalides : ${err.message}`);
    }
    if (err instanceof SamApiError) {
      ctx.logger.warn("tool.call", { tool, ok: false, reason: err.code, status: err.status, duration_ms: Date.now() - started });
      return errorResult(`Erreur SAM : ${err.message}`);
    }
    ctx.logger.error("tool.call.unexpected", { tool, error: err });
    return errorResult("Erreur interne du connecteur SAM. Réessayer ; si le problème persiste, consulter les logs du serveur.");
  }
}

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

interface ListToolDef {
  name: string;
  title: string;
  entity: SamEntity;
  description: string;
  /** Optional convenience parameter mapped to an equality filter, if the live schema has that field. */
  link?: { param: "client_id" | "lead_id"; label: string };
}

function registerListTool(server: McpServer, ctx: ToolContext, def: ListToolDef): void {
  const linkShape = def.link
    ? { [def.link.param]: recordId.optional().describe(`Limiter aux éléments liés à ce ${def.link.label}`) }
    : {};
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: `${def.description} Résultats paginés (20 par défaut, 50 max). Pour connaître les champs filtrables, utiliser get_crm_schema.`,
      inputSchema: { ...listShape, ...linkShape },
      annotations: READ,
    },
    async (args) =>
      run(ctx, def.name, async () => {
        const a = args as z.infer<z.ZodObject<typeof listShape>> & Partial<Record<"client_id" | "lead_id", string>>;
        const sam = await ctx.sam();
        const filters: Filter[] = (a.filters ?? []).map((f) => ({ field: f.field, op: f.op, value: f.value }));
        if (def.link) {
          const linkValue = a[def.link.param];
          if (linkValue !== undefined) {
            // Known fields: check locally. Unknown fields (no readable record): SAM validates the column itself.
            const es = await sam.schema.entity(def.entity).catch(() => undefined);
            if (es && !es.fields.has(def.link.param)) {
              throw new ValidationError(
                `Le schéma de ${def.entity} ne contient pas de champ "${def.link.param}". Utiliser "filters" avec le champ de liaison réel (voir get_crm_schema).`,
              );
            }
            filters.push({ field: def.link.param, op: "eq", value: linkValue });
          }
        }
        await sam.schema.validateReadFields(def.entity, [...filters.map((f) => f.field), ...(a.fields ?? [])]);
        const res = await sam.client.list(def.entity, { limit: a.limit, offset: a.offset, search: a.search, filters });
        const items = res.items.slice(0, a.limit).map((r) => sanitizeRecord(r, LIST_MAX_STRING, a.fields));
        return jsonResult({
          entity: def.entity,
          returned: items.length,
          offset: a.offset,
          limit: a.limit,
          ...(res.total !== undefined ? { total: res.total } : {}),
          has_more: res.total !== undefined ? a.offset + items.length < res.total : items.length === a.limit,
          items,
        });
      }),
  );
}

interface GetToolDef {
  name: string;
  title: string;
  entity: SamEntity;
  description: string;
}

function registerGetTool(server: McpServer, ctx: ToolContext, def: GetToolDef): void {
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: { id: recordId, fields: listShape.fields },
      annotations: READ,
    },
    async ({ id, fields }) =>
      run(ctx, def.name, async () => {
        const sam = await ctx.sam();
        if (fields) await sam.schema.validateReadFields(def.entity, fields);
        const record = await sam.client.get(def.entity, id);
        return jsonResult({ entity: def.entity, item: sanitizeRecord(record, DETAIL_MAX_STRING, fields) });
      }),
  );
}

interface WriteToolDef {
  name: string;
  title: string;
  entity: SamEntity;
  kind: "create" | "update";
  label: string;
  description: string;
  link?: { param: "client_id" | "lead_id"; label: string };
}

interface ConfirmClaims {
  tool: string;
  digest: string;
  sub: string;
}

function confirmationText(mode: WriteMode): string {
  if (mode !== "confirm") return "";
  return (
    " CONTRÔLE HUMAIN OBLIGATOIRE : (1) appeler sans confirmation_token pour obtenir un aperçu, rien n'est écrit ; " +
    "(2) montrer l'aperçu à l'utilisateur et lui demander une validation explicite ; " +
    "(3) seulement après un accord explicite, rappeler avec exactement les mêmes paramètres et le confirmation_token. " +
    "Ne jamais confirmer de sa propre initiative."
  );
}

function registerWriteTool(server: McpServer, ctx: ToolContext, def: WriteToolDef): void {
  const shape = {
    ...(def.kind === "update" ? { id: recordId } : {}),
    ...(def.link ? { [def.link.param]: recordId.describe(`Identifiant du ${def.link.label} concerné`) } : {}),
    data: dataSchema,
    ...(ctx.writeMode === "confirm" ? { confirmation_token: confirmationToken } : {}),
  };

  server.registerTool(
    def.name,
    {
      title: def.title,
      description: `${def.description} Les noms de champs doivent exister dans le schéma SAM (get_crm_schema) ; les champs inconnus sont refusés.${confirmationText(ctx.writeMode)}`,
      inputSchema: shape,
      annotations: def.kind === "create" ? CREATE : UPDATE,
    },
    async (args) =>
      run(ctx, def.name, async () => {
        const a = args as {
          id?: string;
          client_id?: string;
          lead_id?: string;
          data: Record<string, FieldValue>;
          confirmation_token?: string;
        };
        const sam = await ctx.sam();
        const data: Record<string, FieldValue> = { ...a.data };

        if (def.link) {
          const linkValue = a[def.link.param];
          if (linkValue === undefined) throw new ValidationError(`${def.link.param} est requis`);
          const es = await sam.schema.entity(def.entity);
          if (!es) {
            throw new ValidationError(
              `Aucun champ connu pour "${def.entity}" (non décrit par l'API SAM et aucun enregistrement lisible) : écriture refusée par précaution.`,
            );
          }
          if (!es.fields.has(def.link.param)) {
            throw new ValidationError(
              `Le schéma de ${def.entity} ne contient pas de champ "${def.link.param}" : impossible de rattacher le commentaire sans connaître le champ de liaison réel.`,
            );
          }
          if (data[def.link.param] !== undefined && data[def.link.param] !== linkValue) {
            throw new ValidationError(`${def.link.param} est fourni deux fois avec des valeurs différentes`);
          }
          data[def.link.param] = linkValue;
        }
        for (const k of Object.keys(data)) {
          if (SERVER_MANAGED_FIELDS.has(k)) throw new ValidationError(`Le champ "${k}" est géré par SAM et ne peut pas être fourni`);
        }

        await sam.schema.validateWrite(def.entity, data, def.kind);

        // For updates, read the current record: it proves it exists and lets the user compare.
        let before: Record<string, unknown> | undefined;
        if (def.kind === "update" && a.id) {
          const current = await sam.client.get(def.entity, a.id);
          const safe = sanitizeRecord(current, DETAIL_MAX_STRING);
          before = Object.fromEntries(Object.keys(data).map((k) => [k, k in safe ? safe[k] : null]));
        }

        if (ctx.writeMode === "confirm") {
          const digest = await sha256Base64Url(
            canonicalJson({ tool: def.name, entity: def.entity, id: a.id ?? null, account: sam.accountId, data }),
          );
          if (!a.confirmation_token) {
            const token = await ctx.signer.sign("confirm", { tool: def.name, digest, sub: ctx.principal }, CONFIRMATION_TTL_SECONDS);
            ctx.logger.info("tool.write.preview", { tool: def.name, entity: def.entity });
            return jsonResult({
              status: "confirmation_requise",
              action: def.label,
              entity: def.entity,
              ...(a.id ? { id: a.id } : {}),
              ...(before ? { valeurs_actuelles: before } : {}),
              changements: data,
              confirmation_token: token,
              expire_dans_secondes: CONFIRMATION_TTL_SECONDS,
              instructions:
                "Aucune donnée n'a été écrite. Présente ces changements à l'utilisateur et demande-lui de confirmer. " +
                "S'il accepte explicitement, rappelle cet outil avec exactement les mêmes paramètres et ce confirmation_token.",
            });
          }
          const claims = await ctx.signer.verify<ConfirmClaims & { jti?: string; exp?: number }>("confirm", a.confirmation_token);
          if (!claims || claims.tool !== def.name || claims.sub !== ctx.principal) {
            throw new ValidationError("confirmation_token invalide ou expiré : refaire un aperçu et redemander l'accord de l'utilisateur");
          }
          if (claims.digest !== digest) {
            throw new ValidationError(
              "Les paramètres ne correspondent pas à l'aperçu confirmé : refaire un aperçu et redemander l'accord de l'utilisateur",
            );
          }
          if (!claims.jti || !ctx.usedConfirmations.consume(claims.jti, claims.exp ?? 0)) {
            throw new ValidationError("Ce confirmation_token a déjà été utilisé");
          }
        }

        const saved =
          def.kind === "create" ? await sam.client.create(def.entity, data) : await sam.client.update(def.entity, a.id as string, data);
        ctx.logger.info("tool.write.done", { tool: def.name, entity: def.entity });
        return jsonResult({
          status: def.kind === "create" ? "créé" : "mis_à_jour",
          entity: def.entity,
          item: sanitizeRecord(saved, DETAIL_MAX_STRING),
        });
      }),
  );
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export const LIST_TOOLS: ListToolDef[] = [
  { name: "search_clients", title: "Rechercher des clients", entity: "clients", description: "Recherche des clients du CRM SAM par texte libre et/ou filtres." },
  { name: "search_leads", title: "Rechercher des prospects", entity: "leads", description: "Recherche des prospects (leads) du CRM SAM par texte libre et/ou filtres." },
  { name: "list_commerciaux", title: "Lister les commerciaux", entity: "commerciaux", description: "Liste les commerciaux enregistrés dans SAM." },
  { name: "list_distributeurs", title: "Lister les distributeurs", entity: "distributeurs", description: "Liste les distributeurs enregistrés dans SAM." },
  { name: "list_products", title: "Lister les produits", entity: "products", description: "Liste le catalogue de produits SAM." },
  { name: "list_tasks", title: "Lister les tâches", entity: "taches", description: "Liste les tâches SAM (entité `taches`)." },
  { name: "list_appointments", title: "Lister les rendez-vous", entity: "rdv", description: "Liste les rendez-vous SAM (entité `rdv`)." },
  { name: "list_documents", title: "Lister les documents", entity: "documents", description: "Liste les documents référencés dans SAM (métadonnées)." },
  { name: "list_notifications", title: "Lister les notifications", entity: "notifications", description: "Liste les notifications SAM du compte connecté." },
  {
    name: "list_client_comments",
    title: "Commentaires d'un client",
    entity: "client-comments",
    description: "Liste les commentaires associés aux clients.",
    link: { param: "client_id", label: "client" },
  },
  {
    name: "list_lead_comments",
    title: "Commentaires d'un prospect",
    entity: "lead-comments",
    description: "Liste les commentaires associés aux prospects.",
    link: { param: "lead_id", label: "prospect" },
  },
  {
    name: "list_client_products",
    title: "Produits d'un client",
    entity: "client-products",
    description: "Liste les produits associés aux clients (entité `client-products`).",
    link: { param: "client_id", label: "client" },
  },
];

export const GET_TOOLS: GetToolDef[] = [
  { name: "get_client", title: "Fiche client", entity: "clients", description: "Récupère la fiche complète d'un client SAM à partir de son identifiant." },
  { name: "get_lead", title: "Fiche prospect", entity: "leads", description: "Récupère la fiche complète d'un prospect SAM à partir de son identifiant." },
  { name: "get_document", title: "Détail d'un document", entity: "documents", description: "Récupère les informations d'un document SAM à partir de son identifiant." },
];

export const WRITE_TOOLS: WriteToolDef[] = [
  { name: "create_client", title: "Créer un client", entity: "clients", kind: "create", label: "Créer un client", description: "Crée un client dans SAM." },
  { name: "update_client", title: "Modifier un client", entity: "clients", kind: "update", label: "Modifier un client", description: "Modifie les champs indiqués d'un client SAM existant (les autres champs restent inchangés)." },
  { name: "create_lead", title: "Créer un prospect", entity: "leads", kind: "create", label: "Créer un prospect", description: "Crée un prospect (lead) dans SAM." },
  { name: "update_lead", title: "Modifier un prospect", entity: "leads", kind: "update", label: "Modifier un prospect", description: "Modifie les champs indiqués d'un prospect SAM existant." },
  { name: "create_task", title: "Créer une tâche", entity: "taches", kind: "create", label: "Créer une tâche", description: "Crée une tâche dans SAM (entité `taches`)." },
  { name: "update_task", title: "Modifier une tâche", entity: "taches", kind: "update", label: "Modifier une tâche", description: "Modifie une tâche SAM existante (par exemple son statut ou son échéance)." },
  { name: "create_appointment", title: "Créer un rendez-vous", entity: "rdv", kind: "create", label: "Créer un rendez-vous", description: "Crée un rendez-vous dans SAM (entité `rdv`). Pour l'ajouter aussi à Google Agenda, utiliser ensuite le connecteur Google Calendar." },
  { name: "update_appointment", title: "Modifier un rendez-vous", entity: "rdv", kind: "update", label: "Modifier un rendez-vous", description: "Modifie un rendez-vous SAM existant." },
  {
    name: "add_client_comment",
    title: "Commenter un client",
    entity: "client-comments",
    kind: "create",
    label: "Ajouter un commentaire client",
    description: "Ajoute un commentaire sur un client SAM.",
    link: { param: "client_id", label: "client" },
  },
  {
    name: "add_lead_comment",
    title: "Commenter un prospect",
    entity: "lead-comments",
    kind: "create",
    label: "Ajouter un commentaire prospect",
    description: "Ajoute un commentaire sur un prospect SAM.",
    link: { param: "lead_id", label: "prospect" },
  },
];

export function registerTools(server: McpServer, ctx: ToolContext): void {
  for (const def of LIST_TOOLS) registerListTool(server, ctx, def);
  for (const def of GET_TOOLS) registerGetTool(server, ctx, def);

  server.registerTool(
    "get_crm_stats",
    {
      title: "Statistiques du CRM",
      description: "Renvoie les statistiques globales du CRM SAM (endpoint /crm-api/stats).",
      inputSchema: {},
      annotations: READ,
    },
    async () =>
      run(ctx, "get_crm_stats", async () => {
        const sam = await ctx.sam();
        const stats = await sam.client.stats();
        return jsonResult({ stats: sanitizeRecord({ value: stats }, DETAIL_MAX_STRING).value });
      }),
  );

  server.registerTool(
    "get_crm_schema",
    {
      title: "Schéma du CRM",
      description:
        "Renvoie les champs réels des entités SAM (noms, types), déclarés par l'API ou observés sur les enregistrements existants. " +
        "À utiliser avant de filtrer, créer ou modifier pour employer les noms de champs exacts.",
      inputSchema: { entity: z.enum(SAM_ENTITIES).optional().describe("Limiter à une entité") },
      annotations: READ,
    },
    async ({ entity }) =>
      run(ctx, "get_crm_schema", async () => {
        const sam = await ctx.sam();
        const { raw } = await sam.schema.load();
        const targets = entity ? [entity] : [...SAM_ENTITIES];
        const entities = await Promise.all(
          targets.map(async (name) => {
            const es = await sam.schema.entity(name);
            if (!es) {
              return {
                entity: name,
                fields: [],
                note: "Aucun champ connu (non décrit par l'API et aucun enregistrement lisible) : créations et modifications refusées.",
              };
            }
            return {
              entity: name,
              source: es.source === "declared" ? "schéma de l'API" : `observé sur ${es.sampleSize ?? 0} enregistrement(s)`,
              fields: [...es.fields.values()].map((f) => ({
                name: f.name,
                ...(f.type ? { type: f.type } : {}),
                ...(f.required !== undefined ? { required: f.required } : {}),
                ...(f.readOnly || SERVER_MANAGED_FIELDS.has(f.name) ? { read_only: true } : {}),
                ...(f.enumValues ? { values: f.enumValues } : {}),
                ...(f.description ? { description: f.description } : {}),
              })),
            };
          }),
        );
        if (entities.every((e) => e.fields.length === 0)) {
          return jsonResult({
            warning: "Aucun champ connu : les créations et modifications sont désactivées.",
            raw_excerpt: JSON.stringify(raw)?.slice(0, 3000) ?? null,
            entities,
          });
        }
        return jsonResult({
          ...(entities.some((e) => e.source?.startsWith("observé"))
            ? { note: "Champs observés : les champs obligatoires ne sont pas connus, SAM les vérifiera à la création." }
            : {}),
          entities,
        });
      }),
  );

  if (ctx.writeMode !== "disabled") {
    for (const def of WRITE_TOOLS) registerWriteTool(server, ctx, def);
  }
}
