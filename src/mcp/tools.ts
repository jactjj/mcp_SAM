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
  /** send_email is registered only when true (SAM_SEND_EMAIL) and writes are enabled. */
  sendEmail: boolean;
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
  /** Real fields that this tool must never write, with the reason shown to Claude. */
  blockedFields?: { names: string[]; reason: string };
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

const UNVERIFIED_FIELDS_WARNING =
  "Les champs de cette entité ne sont pas connus du connecteur (SAM ne les décrit pas et aucune fiche n'est lisible) : " +
  "les noms de champs n'ont pas été vérifiés, SAM les validera à l'enregistrement.";

type Gate = { preview: true; token: string } | { preview: false };

/**
 * Human-confirmation step shared by every write. In "confirm" mode (or when `always` is set,
 * as for deletions), a call without token returns a preview token; a call with token must carry
 * exactly the same payload (SHA-256 of canonical JSON), for the same tool and account, once.
 */
async function confirmationGate(
  ctx: ToolContext,
  accountId: string,
  tool: string,
  payload: unknown,
  token: string | undefined,
  always: boolean,
): Promise<Gate> {
  if (!always && ctx.writeMode !== "confirm") return { preview: false };
  const digest = await sha256Base64Url(canonicalJson({ tool, account: accountId, payload }));
  if (!token) {
    return { preview: true, token: await ctx.signer.sign("confirm", { tool, digest, sub: ctx.principal }, CONFIRMATION_TTL_SECONDS) };
  }
  const claims = await ctx.signer.verify<ConfirmClaims & { jti?: string; exp?: number }>("confirm", token);
  if (!claims || claims.tool !== tool || claims.sub !== ctx.principal) {
    throw new ValidationError("confirmation_token invalide ou expiré : refaire un aperçu et redemander l'accord de l'utilisateur");
  }
  if (claims.digest !== digest) {
    throw new ValidationError("Les paramètres ne correspondent pas à l'aperçu confirmé : refaire un aperçu et redemander l'accord de l'utilisateur");
  }
  if (!claims.jti || !ctx.usedConfirmations.consume(claims.jti, claims.exp ?? 0)) {
    throw new ValidationError("Ce confirmation_token a déjà été utilisé");
  }
  return { preview: false };
}

const DELETE_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

function registerDeleteTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "delete_record",
    {
      title: "Supprimer une fiche",
      description:
        "Supprime une fiche SAM : client, prospect (leads), tâche (taches), rendez-vous (rdv), commercial, distributeur, produit, document, " +
        "produit client, commentaire ou notification. Vérifier l'identifiant (search_/get_) avant de supprimer." +
        (ctx.writeMode === "confirm"
          ? " EN DEUX TEMPS : (1) appeler sans confirmation_token pour afficher la fiche, rien n'est supprimé ; (2) rappeler avec le " +
            "confirmation_token seulement après l'accord explicite de l'utilisateur pour CETTE suppression."
          : " La suppression est immédiate."),
      inputSchema: {
        entity: z.enum(SAM_ENTITIES).describe("Type de fiche"),
        id: recordId,
        ...(ctx.writeMode === "confirm" ? { confirmation_token: confirmationToken } : {}),
      },
      annotations: DELETE_ANNOTATIONS,
    },
    async (args) =>
      run(ctx, "delete_record", async () => {
        const { entity, id, confirmation_token } = args as { entity: SamEntity; id: string; confirmation_token?: string };
        const sam = await ctx.sam();
        let current: Record<string, unknown> | undefined;
        let readWarning: string | undefined;
        try {
          current = sanitizeRecord(await sam.client.get(entity, id), LIST_MAX_STRING);
        } catch (err) {
          if (err instanceof SamApiError && err.code === "not_found") throw err;
          if (!(err instanceof SamApiError)) throw err;
          readWarning = `La fiche n'a pas pu être relue avant suppression (${err.message}).`;
        }
        const gate = await confirmationGate(ctx, sam.accountId, "delete_record", { entity, id }, confirmation_token, false);
        if (gate.preview) {
          ctx.logger.info("tool.delete.preview", { entity });
          return jsonResult({
            status: "confirmation_requise",
            action: "SUPPRIMER une fiche",
            entity,
            id,
            ...(current ? { fiche_a_supprimer: current } : {}),
            ...(readWarning ? { avertissement: readWarning } : {}),
            confirmation_token: gate.token,
            expire_dans_secondes: CONFIRMATION_TTL_SECONDS,
            instructions:
              "Rien n'a été supprimé. Montre cette fiche à l'utilisateur et demande-lui s'il confirme sa suppression. " +
              "Seulement s'il répond explicitement oui, rappelle delete_record avec les mêmes entity, id et ce confirmation_token.",
          });
        }
        const response = await sam.client.delete(entity, id);
        ctx.logger.info("tool.delete.done", { entity });
        return jsonResult({
          status: "supprimé",
          entity,
          id,
          ...(response && typeof response === "object" ? { reponse_sam: sanitizeRecord(response as Record<string, unknown>, LIST_MAX_STRING) } : {}),
        });
      }),
  );
}

function registerSendEmailTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "send_email",
    {
      title: "Envoyer un email via SAM",
      description:
        "Envoie un email depuis l'expéditeur du CRM SAM (endpoint /send-email) à UN destinataire. Le corps est en HTML simple " +
        "(<p>, <br>, <strong>, <a href>, <ul><li>). Vérifier l'adresse dans la fiche SAM avant l'envoi ; un email envoyé ne peut pas être annulé. " +
        "Pour un brouillon à relire, utiliser plutôt Gmail. Après l'envoi à un prospect, on peut mettre à jour sa fiche (ex. mail_envoye) avec update_lead." +
        confirmationText(ctx.writeMode),
      inputSchema: {
        to: z.string().trim().email("Adresse email invalide").max(254).describe("Adresse du destinataire (une seule)"),
        subject: z.string().trim().min(1).max(200).describe("Objet de l'email"),
        html: z.string().min(1).max(50_000).describe("Corps de l'email en HTML"),
        ...(ctx.writeMode === "confirm" ? { confirmation_token: confirmationToken } : {}),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      run(ctx, "send_email", async () => {
        const a = args as { to: string; subject: string; html: string; confirmation_token?: string };
        const sam = await ctx.sam();
        const gate = await confirmationGate(ctx, sam.accountId, "send_email", { to: a.to, subject: a.subject, html: a.html }, a.confirmation_token, false);
        if (gate.preview) {
          return jsonResult({
            status: "confirmation_requise",
            action: "Envoyer un email via SAM",
            destinataire: a.to,
            objet: a.subject,
            apercu_texte: a.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1500),
            confirmation_token: gate.token,
            expire_dans_secondes: CONFIRMATION_TTL_SECONDS,
            instructions: "Rien n'a été envoyé. Montre l'email à l'utilisateur ; s'il confirme, rappelle send_email avec les mêmes paramètres et ce confirmation_token.",
          });
        }
        await sam.client.sendEmail({ to: a.to, subject: a.subject, html: a.html });
        // Recipient and content are personal data: never logged.
        ctx.logger.info("tool.email.sent");
        return jsonResult({ status: "envoyé", destinataire: a.to, objet: a.subject });
      }),
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
      description: `${def.description} Utiliser les noms de champs réels de SAM (get_crm_schema) : quand ils sont connus, les champs inconnus sont refusés ; sinon SAM les valide.${confirmationText(ctx.writeMode)}`,
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
          if (es && !es.fields.has(def.link.param)) {
            throw new ValidationError(
              `Le schéma de ${def.entity} ne contient pas de champ "${def.link.param}" : impossible de rattacher la fiche sans connaître le champ de liaison réel.`,
            );
          }
          if (data[def.link.param] !== undefined && data[def.link.param] !== linkValue) {
            throw new ValidationError(`${def.link.param} est fourni deux fois avec des valeurs différentes`);
          }
          data[def.link.param] = linkValue;
        }
        for (const k of Object.keys(data)) {
          if (SERVER_MANAGED_FIELDS.has(k)) throw new ValidationError(`Le champ "${k}" est géré par SAM et ne peut pas être fourni`);
          if (def.blockedFields?.names.includes(k)) throw new ValidationError(`Le champ "${k}" ne peut pas être modifié par ce connecteur : ${def.blockedFields.reason}`);
        }

        const verified = await sam.schema.validateWrite(def.entity, data, def.kind);

        // For updates, read the current record: it proves it exists and lets the user compare.
        // A record SAM cannot re-read (400, e.g. its API bug on comments/notifications) does not block the update.
        let before: Record<string, unknown> | undefined;
        let readWarning: string | undefined;
        if (def.kind === "update" && a.id) {
          try {
            const safe = sanitizeRecord(await sam.client.get(def.entity, a.id), DETAIL_MAX_STRING);
            before = Object.fromEntries(Object.keys(data).map((k) => [k, k in safe ? safe[k] : null]));
          } catch (err) {
            if (!(err instanceof SamApiError) || err.code !== "bad_request") throw err;
            readWarning = `Valeurs actuelles illisibles (${err.message}).`;
          }
        }

        const gate = await confirmationGate(ctx, sam.accountId, def.name, { entity: def.entity, id: a.id ?? null, data }, a.confirmation_token, false);
        if (gate.preview) {
          ctx.logger.info("tool.write.preview", { tool: def.name, entity: def.entity });
          return jsonResult({
            status: "confirmation_requise",
            action: def.label,
            entity: def.entity,
            ...(a.id ? { id: a.id } : {}),
            ...(before ? { valeurs_actuelles: before } : {}),
            changements: data,
            ...(verified && !readWarning ? {} : { avertissement: [verified ? "" : UNVERIFIED_FIELDS_WARNING, readWarning ?? ""].filter(Boolean).join(" ") }),
            confirmation_token: gate.token,
            expire_dans_secondes: CONFIRMATION_TTL_SECONDS,
            instructions:
              "Aucune donnée n'a été écrite. Présente ces changements à l'utilisateur et demande-lui de confirmer. " +
              "S'il accepte explicitement, rappelle cet outil avec exactement les mêmes paramètres et ce confirmation_token.",
          });
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
    name: "create_commercial",
    title: "Créer un commercial",
    entity: "commerciaux",
    kind: "create",
    label: "Créer un commercial",
    description:
      "Crée une fiche commercial dans SAM (entité `commerciaux`). Ne crée PAS de compte de connexion au CRM : le champ user_id est refusé.",
    blockedFields: { names: ["user_id"], reason: "le lien avec un compte de connexion SAM se gère dans SAM (il donne accès au CRM)" },
  },
  {
    name: "update_commercial",
    title: "Modifier un commercial",
    entity: "commerciaux",
    kind: "update",
    label: "Modifier un commercial",
    description: "Modifie une fiche commercial SAM existante (coordonnées, distributeur, activité). Le champ user_id (compte de connexion) est refusé.",
    blockedFields: { names: ["user_id"], reason: "le lien avec un compte de connexion SAM se gère dans SAM (il donne accès au CRM)" },
  },
  { name: "create_distributeur", title: "Créer un distributeur", entity: "distributeurs", kind: "create", label: "Créer un distributeur", description: "Crée un distributeur dans SAM." },
  { name: "update_distributeur", title: "Modifier un distributeur", entity: "distributeurs", kind: "update", label: "Modifier un distributeur", description: "Modifie un distributeur SAM existant." },
  { name: "create_product", title: "Créer un produit", entity: "products", kind: "create", label: "Créer un produit", description: "Crée un produit dans le catalogue SAM." },
  { name: "update_product", title: "Modifier un produit", entity: "products", kind: "update", label: "Modifier un produit", description: "Modifie un produit du catalogue SAM." },
  { name: "create_document", title: "Créer un document", entity: "documents", kind: "create", label: "Créer un document", description: "Crée une fiche document dans SAM (métadonnées : type, statut, client… ; pas d'envoi de fichier)." },
  { name: "update_document", title: "Modifier un document", entity: "documents", kind: "update", label: "Modifier un document", description: "Modifie une fiche document SAM (statut, remarques…)." },
  {
    name: "add_client_product",
    title: "Associer un produit à un client",
    entity: "client-products",
    kind: "create",
    label: "Associer un produit à un client",
    description: "Associe un produit à un client SAM (entité `client-products`).",
    link: { param: "client_id", label: "client" },
  },
  { name: "update_client_product", title: "Modifier un produit client", entity: "client-products", kind: "update", label: "Modifier un produit client", description: "Modifie l'association d'un produit à un client." },
  { name: "update_client_comment", title: "Modifier un commentaire client", entity: "client-comments", kind: "update", label: "Modifier un commentaire client", description: "Modifie un commentaire existant sur un client." },
  { name: "update_lead_comment", title: "Modifier un commentaire prospect", entity: "lead-comments", kind: "update", label: "Modifier un commentaire prospect", description: "Modifie un commentaire existant sur un prospect." },
  { name: "update_notification", title: "Modifier une notification", entity: "notifications", kind: "update", label: "Modifier une notification", description: "Modifie une notification SAM (par exemple la marquer comme lue)." },
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

// ---------------------------------------------------------------------------
// Email preparation (combined with the Gmail connector by Claude)
// ---------------------------------------------------------------------------

const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTACT_KEYS = /(^|_)(nom|prenom|first_name|last_name|societe|email|telephone|ville|code_postal|statut|source|commentaire|commercial_id|distributeur_id|dirigeant|activity|reminder)(_|$)/;

function pick(rec: Record<string, unknown>, pattern: RegExp): Record<string, unknown> {
  return Object.fromEntries(Object.entries(rec).filter(([k, v]) => pattern.test(k) && v !== null && v !== "" && typeof v !== "boolean"));
}

function emailsOf(rec: Record<string, unknown>): string[] {
  return Object.entries(rec)
    .filter(([k, v]) => /email/.test(k) && typeof v === "string" && EMAIL_VALUE.test(v))
    .map(([, v]) => v as string);
}

function registerPrepareEmailTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "prepare_email",
    {
      title: "Préparer un email",
      description:
        "À appeler AVANT de rédiger un email à un client ou un prospect SAM. Rassemble la fiche (coordonnées, société, statuts), " +
        "le commercial et le distributeur rattachés, les dernières tâches et rendez-vous, et donne les recherches Gmail à lancer " +
        "pour s'appuyer sur les échanges passés avec ce contact et sur les emails du même type déjà envoyés.",
      inputSchema: {
        client_id: recordId.optional().describe("Identifiant du client (ou lead_id)"),
        lead_id: recordId.optional().describe("Identifiant du prospect (ou client_id)"),
        objet: z.string().trim().max(300).optional().describe("Ce que l'utilisateur veut envoyer, ex. « relance devis », « pré-demande »"),
      },
      annotations: READ,
    },
    async ({ client_id, lead_id, objet }) =>
      run(ctx, "prepare_email", async () => {
        if ((client_id ? 1 : 0) + (lead_id ? 1 : 0) !== 1) throw new ValidationError("Indiquer soit client_id, soit lead_id");
        const sam = await ctx.sam();
        const entity: SamEntity = client_id ? "clients" : "leads";
        const id = (client_id ?? lead_id) as string;
        const linkField = client_id ? "client_id" : "lead_id";
        const record = await sam.client.get(entity, id);
        const contact = sanitizeRecord(pick(record, CONTACT_KEYS), LIST_MAX_STRING);
        const emails = emailsOf(record);

        const optional = async <T>(fn: () => Promise<T>): Promise<T | undefined> => fn().catch(() => undefined);
        const commercialId = typeof record.commercial_id === "string" ? record.commercial_id : undefined;
        const distributeurId = typeof record.distributeur_id === "string" ? record.distributeur_id : undefined;
        const [commercial, distributeur, taches, rdv] = await Promise.all([
          commercialId ? optional(() => sam.client.get("commerciaux", commercialId)) : undefined,
          distributeurId ? optional(() => sam.client.get("distributeurs", distributeurId)) : undefined,
          optional(() => sam.client.list("taches", { limit: 5, offset: 0, filters: [{ field: linkField, op: "eq", value: id }] })),
          optional(() => sam.client.list("rdv", { limit: 5, offset: 0, filters: [{ field: linkField, op: "eq", value: id }] })),
        ]);
        const person = (r: Record<string, unknown> | undefined) =>
          r ? sanitizeRecord(pick(r, /(name|nom|email|telephone|dirigeant)/), LIST_MAX_STRING) : undefined;
        const brief = (items: Record<string, unknown>[] | undefined, pattern: RegExp) =>
          items?.map((t) => sanitizeRecord(pick(t, pattern), LIST_MAX_STRING));

        const societe = typeof record.societe === "string" && record.societe.trim() ? record.societe.trim() : undefined;
        const historique = emails.map((e) => `from:${e} OR to:${e}`);
        if (societe) historique.push(`"${societe}"`);
        const modeles = objet ? [`in:sent "${objet}"`, `in:sent ${objet}`] : ["in:sent (relance OR pré-demande OR devis OR dossier)"];

        return jsonResult({
          entity,
          id,
          contact,
          emails_du_contact: emails,
          ...(person(commercial) ? { commercial_rattache: person(commercial) } : {}),
          ...(person(distributeur) ? { distributeur_rattache: person(distributeur) } : {}),
          ...(taches ? { dernieres_taches: brief(taches.items, /(titre|statut|due|description)/) } : {}),
          ...(rdv ? { rendez_vous: brief(rdv.items, /(titre|date|end_at|statut|type|lieu|commentaire)/) } : {}),
          recherches_gmail: { historique_avec_le_contact: historique, emails_du_meme_type_deja_envoyes: modeles },
          methode: [
            "1. Avec le connecteur Gmail, lire les derniers échanges avec ce contact (recherches « historique ») : contexte, ton, ce qui a déjà été dit ou promis.",
            "2. Chercher dans les emails envoyés un email du même type adressé à un autre contact (recherches « emails du même type ») et reprendre sa structure et ses formulations habituelles.",
            "3. Rédiger avec les informations de cette fiche SAM. Ne rien inventer (montant, date, pièce) qui ne figure ni dans SAM ni dans les emails.",
            "4. Si les emails passés mettent le commercial en copie, faire de même (son email est dans commercial_rattache).",
            "5. Par défaut, créer un brouillon Gmail et le montrer ; l'envoyer directement seulement si l'utilisateur l'a demandé.",
            "6. Après l'envoi, mettre SAM à jour si c'est utile (ex. champ mail_envoye d'un prospect, tâche de relance).",
          ],
          ...(emails.length === 0 ? { avertissement: "Aucune adresse email valide sur cette fiche : demander l'adresse à l'utilisateur." } : {}),
        });
      }),
  );
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  for (const def of LIST_TOOLS) registerListTool(server, ctx, def);
  for (const def of GET_TOOLS) registerGetTool(server, ctx, def);
  registerPrepareEmailTool(server, ctx);

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
    registerDeleteTool(server, ctx);
    if (ctx.sendEmail) registerSendEmailTool(server, ctx);
  }
}
