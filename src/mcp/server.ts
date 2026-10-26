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
    "Suppression : uniquement avec delete_record.",
    "L'envoi d'emails par SAM n'est pas disponible via ce connecteur : utiliser Gmail.",
    "Pour les emails, l'agenda et les documents, combine ce connecteur avec les connecteurs Google Workspace (Gmail, Google Calendar, Drive) : " +
      "par exemple, lis la fiche client ici puis rédige un brouillon Gmail, ou crée le rendez-vous dans SAM puis dans Google Calendar.",
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
