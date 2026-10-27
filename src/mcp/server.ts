import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { type ToolContext, registerTools } from "./tools.js";

export const SERVER_NAME = "sam-crm";
export const SERVER_VERSION = "0.1.0";

function instructions(ctx: ToolContext): string {
  const writes =
    ctx.writeMode === "disabled"
      ? "Ce serveur est en lecture seule : aucune création, modification ni suppression n'est possible."
      : ctx.writeMode === "confirm"
        ? "Toute création ou modification se fait en deux temps : un aperçu (rien n'est écrit), puis une confirmation " +
          "avec le confirmation_token UNIQUEMENT après accord explicite de l'utilisateur."
        : "Mode direct : les créations, modifications et suppressions sont appliquées immédiatement, sans étape de confirmation. " +
          "Exécute directement ce que l'utilisateur demande explicitement. Avant une suppression ou une action sur plusieurs fiches, " +
          "vérifie d'abord que tu as la bonne fiche (recherche ou lecture) ; si la demande est ambiguë, pose la question.";
  return [
    `Compte SAM connecté : ${ctx.accountLabel}. Les données visibles et les actions effectuées sont celles de ce compte.`,
    "Connecteur du CRM SAM (clients, prospects, commerciaux, distributeurs, produits, tâches, rendez-vous, documents, commentaires, notifications).",
    "Utilise get_crm_schema pour connaître les noms exacts des champs avant de filtrer, créer ou modifier. N'invente jamais de champ.",
    writes,
    "Suppression : delete_record pour une fiche.",
    "Plusieurs fiches à créer, modifier ou supprimer : utilise batch_write (jusqu'à 50 opérations en un seul appel) plutôt qu'un appel par fiche.",
    "Actions du CRM : convert_lead pour convertir un prospect en client ou distributeur (comme le bouton du CRM) ; set_reminder pour la date de relance d'un client ; " +
      "la pré-demande CARSAT est le statut statut_sam = pre_demande d'un client (update_client) : SAM refuse si des documents bloquants manquent, explique alors lesquels.",
    ...(ctx.directEnabled
      ? [
          "Emails types du CRM : list_email_templates, puis preview_template_email (aperçu) et send_template_email (envoi avec copies du modèle, commercial en copie si demandé, inscription dans l'historique de la fiche).",
          "Fichiers : pour ranger une pièce (ex. pièce jointe Gmail : attestation URSSAF, DUERP, facture) dans le dossier d'un client, utilise create_upload_link et donne le lien à l'utilisateur, qui y dépose le fichier.",
          "Comptes : create_commercial_account crée l'accès CRM d'un commercial et lui envoie ses identifiants ; toujours après accord explicite de l'utilisateur.",
        ]
      : []),
    ctx.sendEmail && ctx.writeMode !== "disabled"
      ? "Emails : send_email envoie depuis l'expéditeur du CRM SAM (HTML) ; pour un brouillon à relire, utiliser Gmail."
      : "L'envoi d'emails par SAM n'est pas activé sur ce connecteur : utiliser Gmail.",
    "Emails à un client ou un prospect : appelle d'abord prepare_email, puis, avec le connecteur Gmail, lis l'historique des échanges avec ce contact " +
      "et un email du même type déjà envoyé, et rédige dans le même style à partir de la fiche SAM. Crée un brouillon Gmail, ou envoie si l'utilisateur le demande, puis mets SAM à jour.",
    "Agenda et documents : combine ce connecteur avec Google Calendar et Drive (ex. créer le rendez-vous dans SAM puis dans Google Calendar).",
    "Les résultats sont paginés et les textes longs tronqués : affine avec search, filters, fields, limit et offset.",
  ].join("\n");
}

/** Builds one MCP server instance (one per HTTP request in stateless mode). */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "SAM CRM" },
    {
      capabilities: { tools: {} },
      instructions: instructions(ctx),
      // Ajv relies on code generation, which Cloudflare Workers forbid.
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    },
  );
  registerTools(server, ctx);
  return server;
}
