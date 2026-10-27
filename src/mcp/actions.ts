/**
 * Business actions of the SAM CRM, reproduced from SAM's web app code (read on 2026-10-27,
 * with SAM's agreement): lead conversion, reminder date, email templates, file deposit links,
 * commercial accounts. Field names here come from that code, not from guesses.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SamRecord } from "../sam/client.js";
import { SamApiError, ValidationError } from "../sam/errors.js";
import { DETAIL_MAX_STRING, LIST_MAX_STRING, jsonResult, sanitizeRecord } from "./output.js";
import { TEMPLATE_ENTITY_TYPES, type TemplateEntityType, buildContext, renderTemplate } from "./templates.js";
import {
  CONFIRMATION_TTL_SECONDS,
  READ,
  type SamSession,
  type ToolContext,
  confirmationGate,
  confirmationText,
  confirmationToken,
  recordId,
  run,
} from "./tools.js";

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
export const UPLOAD_LINK_TTL_SECONDS = 6 * 3600;
const MAX_TEMPLATE_ATTACHMENTS_BYTES = 10 * 1024 * 1024;

const emailAddress = z.string().trim().email("Adresse email invalide").max(254);
const emailList = z.array(emailAddress).max(10);

function requireDirect(sam: SamSession) {
  if (!sam.direct) throw new ValidationError("Fonction indisponible : SAM_SUPABASE_ANON_KEY n'est pas configurée sur le serveur");
  return sam.direct;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

/** 09:00 Europe/Paris on `date` (YYYY-MM-DD), as an ISO instant — what the web app stores for a reminder. */
export function parisNineAmIso(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, 9, 0, 0);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(guess))
      .map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute));
  return new Date(guess - (wall - guess)).toISOString();
}

// ---------------------------------------------------------------------------
// Lead conversion (button « Convertir en client » / « Convertir en distributeur »)
// ---------------------------------------------------------------------------

function registerConvertLead(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "convert_lead",
    {
      title: "Convertir un prospect",
      description:
        "Convertit un prospect (lead) en client ou en distributeur, exactement comme le bouton du CRM : création de la fiche à partir des " +
        "informations du prospect, puis prospect passé au statut « converti » avec la date et l'utilisateur. Pour un client, un distributeur " +
        "est obligatoire (celui du prospect, ou distributeur_id). accompagnement_carsat : SAM accompagne-t-il le client pour son dossier CARSAT (oui par défaut)." +
        confirmationText(ctx.writeMode),
      inputSchema: {
        lead_id: recordId.describe("Identifiant du prospect"),
        cible: z.enum(["client", "distributeur"]).default("client").describe("client (par défaut) ou distributeur"),
        distributeur_id: recordId.optional().describe("Distributeur du futur client, si le prospect n'en a pas"),
        accompagnement_carsat: z.boolean().default(true).describe("Accompagnement CARSAT par SAM (client uniquement)"),
        ...(ctx.writeMode === "confirm" ? { confirmation_token: confirmationToken } : {}),
      },
      annotations: WRITE,
    },
    async (args) =>
      run(ctx, "convert_lead", async () => {
        const a = args as { lead_id: string; cible: "client" | "distributeur"; distributeur_id?: string; accompagnement_carsat: boolean; confirmation_token?: string };
        const sam = await ctx.sam();
        const lead = await sam.client.get("leads", a.lead_id);
        if (lead.statut === "converti" || lead.converted_to_client_id || lead.converted_to_distributeur_id) {
          throw new ValidationError("Ce prospect est déjà converti");
        }
        const fullName = `${lead.prenom ?? ""} ${lead.nom ?? ""}`.trim();
        let entity: "clients" | "distributeurs";
        let payload: SamRecord;
        if (a.cible === "client") {
          const distributeurId = a.distributeur_id ?? str(lead.distributeur_id);
          if (!distributeurId) throw new ValidationError("Aucun distributeur associé à ce lead. Attribuez d'abord un distributeur (distributeur_id).");
          entity = "clients";
          payload = {
            nom: lead.nom ?? "",
            prenom: lead.prenom ?? "",
            societe: str(lead.societe),
            siret: str(lead.siret),
            email: str(lead.email),
            telephone: str(lead.telephone),
            telephone_2: str(lead.telephone_2),
            adresse: str(lead.adresse),
            code_postal: str(lead.code_postal),
            ville: str(lead.ville),
            commentaire: str(lead.commentaire),
            distributeur_id: distributeurId,
            commercial_id: str(lead.commercial_id),
            converted_from_lead_id: a.lead_id,
            is_lead_converti: true,
            accompagnement_carsat: a.accompagnement_carsat,
          };
        } else {
          entity = "distributeurs";
          payload = {
            nom_distributeur: str(lead.societe) ?? fullName,
            dirigeant_societe: fullName,
            email: lead.email ?? null,
            telephone: lead.telephone ?? null,
            siret: lead.siret ?? null,
            adresse: lead.adresse ?? null,
            code_postal: lead.code_postal ?? null,
            ville: lead.ville ?? null,
            commentaire: lead.commentaire ?? null,
            statut: "actif",
            is_active: true,
          };
        }
        const gate = await confirmationGate(ctx, sam.accountId, "convert_lead", { lead: a.lead_id, entity, payload }, a.confirmation_token, false);
        if (gate.preview) {
          return jsonResult({
            status: "confirmation_requise",
            action: `Convertir le prospect en ${a.cible}`,
            fiche_creee: sanitizeRecord(payload, LIST_MAX_STRING),
            prospect: { id: a.lead_id, nouveau_statut: "converti" },
            confirmation_token: gate.token,
            expire_dans_secondes: CONFIRMATION_TTL_SECONDS,
          });
        }
        const created = await sam.client.create(entity, payload);
        const createdId = typeof created.id === "string" ? created.id : undefined;
        try {
          await sam.client.update("leads", a.lead_id, {
            statut: "converti",
            [a.cible === "client" ? "converted_to_client_id" : "converted_to_distributeur_id"]: createdId ?? null,
            converted_at: new Date().toISOString(),
            converted_by_user_id: (await sam.userId()) ?? null,
          });
        } catch (err) {
          if (err instanceof SamApiError) {
            throw new SamApiError(`${a.cible} créé (id ${createdId}) mais le prospect n'a pas pu être marqué converti : ${err.message}`, err.status, err.code);
          }
          throw err;
        }
        ctx.logger.info("tool.convert_lead.done", { cible: a.cible });
        return jsonResult({ status: "converti", cible: a.cible, prospect_id: a.lead_id, fiche_creee: sanitizeRecord(created, DETAIL_MAX_STRING) });
      }),
  );
}

// ---------------------------------------------------------------------------
// Reminder date (« Date de relance » : SAM receives a notification on that day)
// ---------------------------------------------------------------------------

function registerSetReminder(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "set_reminder",
    {
      title: "Programmer une relance",
      description:
        "Fixe la date de relance d'un client : ce jour-là, SAM reçoit une notification de relance pour cette fiche (comme le champ « Date de relance » du CRM). " +
        "date au format AAAA-MM-JJ ; null pour supprimer la relance." +
        confirmationText(ctx.writeMode),
      inputSchema: {
        client_id: recordId,
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Format attendu : AAAA-MM-JJ").nullable(),
        ...(ctx.writeMode === "confirm" ? { confirmation_token: confirmationToken } : {}),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    async (args) =>
      run(ctx, "set_reminder", async () => {
        const a = args as { client_id: string; date: string | null; confirmation_token?: string };
        const sam = await ctx.sam();
        const current = await sam.client.get("clients", a.client_id);
        const value = a.date ? parisNineAmIso(a.date) : null;
        const gate = await confirmationGate(ctx, sam.accountId, "set_reminder", { id: a.client_id, value }, a.confirmation_token, false);
        if (gate.preview) {
          return jsonResult({ status: "confirmation_requise", relance_actuelle: current.next_reminder_at ?? null, nouvelle_relance: value, confirmation_token: gate.token });
        }
        const saved = await sam.client.update("clients", a.client_id, { next_reminder_at: value });
        return jsonResult({ status: value ? "relance_programmée" : "relance_supprimée", client_id: a.client_id, next_reminder_at: saved.next_reminder_at ?? value });
      }),
  );
}

// ---------------------------------------------------------------------------
// Email templates of the CRM
// ---------------------------------------------------------------------------

async function loadTemplate(sam: SamSession, templateId: string) {
  const direct = requireDirect(sam);
  const [tpl] = await direct.select("email_templates", new URLSearchParams({ select: "*", id: `eq.${templateId}`, limit: "1" }));
  if (!tpl) throw new ValidationError("Modèle d'email introuvable (voir list_email_templates)");
  if (tpl.status === "archive") throw new ValidationError("Ce modèle est archivé");
  const attachments = await direct.select(
    "email_template_attachments",
    new URLSearchParams({ select: "*", email_template_id: `eq.${templateId}`, order: "display_order.asc" }),
  );
  return { tpl, attachments };
}

function registerTemplateTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_email_templates",
    {
      title: "Modèles d'email du CRM",
      description:
        "Liste les modèles d'email prêts dans le CRM SAM (catégories : relance, rdv, documents, devis, autre ; cible : client, distributeur, commercial, client_et_distributeur). " +
        "À utiliser avant d'envoyer un email type (pré-demande, relance, demande de documents…).",
      inputSchema: {
        categorie: z.enum(["relance", "rdv", "documents", "devis", "autre"]).optional(),
        cible: z.enum(["client", "distributeur", "commercial", "client_et_distributeur"]).optional(),
        inclure_archives: z.boolean().default(false),
      },
      annotations: READ,
    },
    async ({ categorie, cible, inclure_archives }) =>
      run(ctx, "list_email_templates", async () => {
        const direct = requireDirect(await ctx.sam());
        const q = new URLSearchParams({ select: "id,name,category,target_type,status,subject_template,default_cc,default_bcc,updated_at", order: "name.asc" });
        if (categorie) q.set("category", `eq.${categorie}`);
        if (cible) q.set("target_type", `eq.${cible}`);
        if (!inclure_archives) q.set("status", "neq.archive");
        const rows = await direct.select("email_templates", q);
        const att = await direct.select("email_template_attachments", new URLSearchParams({ select: "email_template_id,attachment_type" }));
        return jsonResult({
          modeles: rows.map((r) => ({
            id: r.id,
            nom: r.name,
            categorie: r.category,
            cible: r.target_type,
            statut: r.status,
            objet: r.subject_template,
            copies_par_defaut: r.default_cc ?? [],
            pieces_jointes: att.filter((x) => x.email_template_id === r.id).map((x) => x.attachment_type),
          })),
        });
      }),
  );

  const shape = {
    template_id: recordId.describe("Identifiant du modèle (list_email_templates)"),
    entity_type: z.enum(TEMPLATE_ENTITY_TYPES).describe("Fiche concernée : client, lead, distributeur ou commercial"),
    entity_id: recordId,
    to: emailList.optional().describe("Destinataires ; par défaut l'email de la fiche"),
    cc: emailList.optional().describe("Copies en plus de celles du modèle"),
    bcc: emailList.optional(),
    cc_commercial: z.boolean().default(false).describe("Mettre le commercial rattaché en copie"),
  };

  const prepare = async (sam: SamSession, a: z.infer<z.ZodObject<typeof shape>>) => {
    const { tpl, attachments } = await loadTemplate(sam, a.template_id);
    const context = await buildContext(sam.client, requireDirect(sam), a.entity_type as TemplateEntityType, a.entity_id);
    const email = renderTemplate(tpl, context, a.entity_type as TemplateEntityType, { to: a.to, cc: a.cc, bcc: a.bcc, ccCommercial: a.cc_commercial });
    return { tpl, attachments, email };
  };

  server.registerTool(
    "preview_template_email",
    {
      title: "Aperçu d'un email type",
      description:
        "Remplit un modèle d'email du CRM avec les informations d'une fiche et montre le résultat (destinataires, copies, objet, texte, variables manquantes, pièces jointes) sans rien envoyer.",
      inputSchema: shape,
      annotations: READ,
    },
    async (args) =>
      run(ctx, "preview_template_email", async () => {
        const sam = await ctx.sam();
        const { tpl, attachments, email } = await prepare(sam, args as z.infer<z.ZodObject<typeof shape>>);
        return jsonResult({
          modele: tpl.name,
          destinataires: email.to,
          copies: email.cc,
          copies_cachees: email.bcc,
          objet: email.subject,
          texte: email.html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").slice(0, 4000),
          variables_manquantes: email.missing,
          pieces_jointes: attachments.map((x) => ({ type: x.attachment_type, nom: x.filename_override ?? x.storage_path ?? x.file_url ?? null })),
          ...(email.to.length === 0 ? { avertissement: "Aucun destinataire : la fiche n'a pas d'email, indiquer `to`." } : {}),
        });
      }),
  );

  if (!ctx.sendEmail || ctx.writeMode === "disabled") return;

  server.registerTool(
    "send_template_email",
    {
      title: "Envoyer un email type",
      description:
        "Envoie un modèle d'email du CRM depuis l'expéditeur SAM, rempli avec les informations de la fiche, avec les copies du modèle " +
        "(et le commercial si cc_commercial), puis l'inscrit dans l'historique email de la fiche, comme le CRM. Refusé si des variables restent vides " +
        "(utiliser preview_template_email pour vérifier)." +
        confirmationText(ctx.writeMode),
      inputSchema: { ...shape, ...(ctx.writeMode === "confirm" ? { confirmation_token: confirmationToken } : {}) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      run(ctx, "send_template_email", async () => {
        const a = args as z.infer<z.ZodObject<typeof shape>> & { confirmation_token?: string };
        const sam = await ctx.sam();
        const direct = requireDirect(sam);
        const { tpl, attachments, email } = await prepare(sam, a);
        if (email.to.length === 0) throw new ValidationError("Aucun destinataire : la fiche n'a pas d'email, indiquer `to`");
        if (email.missing.length > 0) throw new ValidationError(`Variables sans valeur dans la fiche : ${email.missing.join(", ")}. Compléter la fiche ou choisir un autre modèle.`);
        const unsupported = attachments.filter((x) => x.attachment_type !== "static_pdf");
        if (unsupported.length > 0) {
          throw new ValidationError("Ce modèle contient une pièce jointe générée par le CRM (PDF rempli automatiquement) : l'envoyer depuis le CRM.");
        }
        const gate = await confirmationGate(ctx, sam.accountId, "send_template_email", { a: { ...a, confirmation_token: undefined } }, a.confirmation_token, false);
        if (gate.preview) {
          return jsonResult({ status: "confirmation_requise", destinataires: email.to, copies: email.cc, objet: email.subject, confirmation_token: gate.token });
        }
        // Static attachments, downloaded like the web app does.
        const files: { filename: string; content: string }[] = [];
        let total = 0;
        for (const x of attachments) {
          const url = str(x.file_url);
          if (!url) continue;
          const bytes = await direct.downloadStorageFile(url, MAX_TEMPLATE_ATTACHMENTS_BYTES);
          total += bytes.byteLength;
          if (total > MAX_TEMPLATE_ATTACHMENTS_BYTES) throw new ValidationError("Pièces jointes du modèle trop volumineuses");
          files.push({ filename: str(x.filename_override) ?? url.split("/").pop()?.split("?")[0] ?? "piece-jointe.pdf", content: toBase64(bytes) });
        }
        const userId = await sam.userId();
        const log = (status: "sent" | "failed", extra: Record<string, unknown>) =>
          direct
            .insert("email_logs", {
              entity_type: a.entity_type,
              entity_id: a.entity_id,
              email_template_id: a.template_id,
              to_emails: email.to,
              cc_emails: email.cc.length ? email.cc : null,
              bcc_emails: email.bcc.length ? email.bcc : null,
              subject_final: email.subject,
              body_final: email.html,
              attachments: attachments.map((x) => ({ name: str(x.filename_override) ?? "", url: str(x.file_url) ?? "" })),
              status,
              sent_by_user_id: userId ?? null,
              ...extra,
            })
            .then(() => true)
            .catch(() => false);
        let result: unknown;
        try {
          result = await sam.client.sendEmail({ to: email.to, subject: email.subject, html: email.html, cc: email.cc, bcc: email.bcc, attachments: files });
        } catch (err) {
          await log("failed", { provider_message_id: null, error_message: err instanceof Error ? err.message.slice(0, 300) : "Erreur" });
          throw err;
        }
        const providerId = result && typeof result === "object" && typeof (result as Record<string, unknown>).id === "string" ? (result as Record<string, unknown>).id : null;
        const logged = await log("sent", { provider_message_id: providerId, error_message: null });
        ctx.logger.info("tool.email.sent", { template: true, logged });
        return jsonResult({
          status: "envoyé",
          modele: tpl.name,
          destinataires: email.to,
          copies: email.cc,
          objet: email.subject,
          historique: logged ? "inscrit dans l'historique de la fiche" : "ATTENTION : envoyé mais non inscrit dans l'historique",
        });
      }),
  );
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------------------------------------------------------------------------
// File deposit link (the file is dropped by the user on a one-time page)
// ---------------------------------------------------------------------------

export interface UploadClaims {
  sub: string;
  client_id: string;
  document_id?: string;
  type_document: string;
  titre?: string;
  libelle: string;
}

function registerUploadLink(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "create_upload_link",
    {
      title: "Lien de dépôt de fichier",
      description:
        "Crée un lien à usage unique (valable 6 h) pour déposer un fichier (PDF, JPG, PNG) dans le dossier d'un client, rangé exactement comme le CRM " +
        "(document passé « en révision »). Indiquer le document à compléter (type_document, ex. attestation_urssaf, rib, mandat… ou document_id), " +
        "ou un titre pour un document personnalisé. Donner ensuite le lien à l'utilisateur : il y glisse le fichier (par exemple la pièce jointe téléchargée depuis Gmail).",
      inputSchema: {
        client_id: recordId,
        type_document: z.string().regex(/^[a-z0-9_]{2,60}$/).optional().describe("Type du document attendu dans le dossier"),
        document_id: recordId.optional(),
        titre: z.string().trim().min(2).max(120).optional().describe("Pour un document personnalisé (hors liste)"),
      },
      annotations: WRITE,
    },
    async (args) =>
      run(ctx, "create_upload_link", async () => {
        const a = args as { client_id: string; type_document?: string; document_id?: string; titre?: string };
        if ([a.type_document, a.document_id, a.titre].filter(Boolean).length !== 1) {
          throw new ValidationError("Indiquer soit type_document, soit document_id, soit titre (document personnalisé)");
        }
        const sam = await ctx.sam();
        requireDirect(sam);
        const client = await sam.client.get("clients", a.client_id);
        const libelleClient = [client.societe, `${client.prenom ?? ""} ${client.nom ?? ""}`.trim()].filter((x) => typeof x === "string" && x).join(" – ");
        let claims: UploadClaims;
        if (a.titre) {
          claims = { sub: ctx.principal, client_id: a.client_id, type_document: "custom", titre: a.titre, libelle: `${a.titre} – ${libelleClient}` };
        } else {
          const docs = await sam.client.list("documents", { limit: 50, offset: 0, filters: [{ field: "client_id", op: "eq", value: a.client_id }] });
          const doc = a.document_id ? docs.items.find((d) => d.id === a.document_id) : docs.items.find((d) => d.type_document === a.type_document);
          if (!doc || typeof doc.id !== "string") {
            const types = [...new Set(docs.items.map((d) => d.type_document).filter(Boolean))].join(", ");
            throw new ValidationError(`Document introuvable dans le dossier de ce client. Types présents : ${types || "aucun"} (ou utiliser titre pour un document personnalisé).`);
          }
          claims = { sub: ctx.principal, client_id: a.client_id, document_id: doc.id, type_document: String(doc.type_document), libelle: `${String(doc.type_document)} – ${libelleClient}` };
        }
        const token = await ctx.signer.sign("upload", { ...claims }, UPLOAD_LINK_TTL_SECONDS);
        return jsonResult({
          lien: `${ctx.publicBaseUrl}/upload/${token}`,
          document: claims.libelle,
          expire_dans_heures: UPLOAD_LINK_TTL_SECONDS / 3600,
          instructions: "Donne ce lien à l'utilisateur : il l'ouvre et y dépose le fichier (PDF, JPG ou PNG, 20 Mo max). Le lien ne sert qu'une fois.",
        });
      }),
  );
}

// ---------------------------------------------------------------------------
// Commercial user accounts (always confirmed: it grants access to the CRM)
// ---------------------------------------------------------------------------

export function generatePassword(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const pwd = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
    if (/[A-Z]/.test(pwd) && /[a-z]/.test(pwd) && /\d/.test(pwd)) return pwd;
  }
}

function registerCommercialAccount(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "create_commercial_account",
    {
      title: "Créer l'accès CRM d'un commercial",
      description:
        "Crée le compte de connexion au CRM d'un commercial existant (rôle commercial) et lui envoie ses identifiants par email, comme le CRM. " +
        "Le mot de passe est généré par le serveur et n'est jamais visible. TOUJOURS EN DEUX TEMPS, quel que soit le mode : aperçu, puis " +
        "confirmation_token après l'accord explicite de l'utilisateur, car cela donne accès au CRM.",
      inputSchema: { commercial_id: recordId, confirmation_token: confirmationToken },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ commercial_id, confirmation_token }) =>
      run(ctx, "create_commercial_account", async () => {
        const sam = await ctx.sam();
        const direct = requireDirect(sam);
        const c = await sam.client.get("commerciaux", commercial_id);
        if (!str(c.email)) throw new ValidationError("Ce commercial n'a pas d'email : le compléter avant de créer son accès");
        if (str(c.user_id)) throw new ValidationError("Ce commercial a déjà un compte de connexion");
        const gate = await confirmationGate(ctx, sam.accountId, "create_commercial_account", { commercial_id }, confirmation_token, true);
        if (gate.preview) {
          return jsonResult({
            status: "confirmation_requise",
            action: "Créer un accès au CRM (rôle commercial) et envoyer les identifiants par email",
            commercial: { prenom: c.first_name ?? null, nom: c.last_name ?? null, email: c.email },
            confirmation_token: gate.token,
            expire_dans_secondes: CONFIRMATION_TTL_SECONDS,
            instructions: "Rien n'a été créé. Demande à l'utilisateur de confirmer la création de cet accès ; s'il accepte, rappelle l'outil avec ce confirmation_token.",
          });
        }
        const password = generatePassword();
        await direct.invoke("create-user-account", {
          email: c.email,
          password,
          firstName: c.first_name ?? "",
          lastName: c.last_name ?? "",
          role: "commercial",
          entityId: commercial_id,
          distributeurId: c.distributeur_id ?? null,
        });
        let sent = true;
        try {
          await direct.invoke("send-access-credentials-commercial", { commercialId: commercial_id, password });
        } catch {
          sent = false;
        }
        ctx.logger.info("tool.commercial_account.created", { sent });
        return jsonResult({
          status: "compte_créé",
          email: c.email,
          identifiants_envoyes: sent,
          ...(sent ? {} : { avertissement: "Compte créé mais l'envoi des identifiants a échoué : utiliser le bouton « Envoyer les accès » du CRM." }),
        });
      }),
  );
}

export function registerActionTools(server: McpServer, ctx: ToolContext): void {
  if (ctx.writeMode !== "disabled") {
    registerConvertLead(server, ctx);
    registerSetReminder(server, ctx);
  }
  if (!ctx.directEnabled) return;
  registerTemplateTools(server, ctx);
  if (ctx.writeMode !== "disabled") {
    registerUploadLink(server, ctx);
    registerCommercialAccount(server, ctx);
  }
}

