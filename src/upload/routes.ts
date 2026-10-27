/**
 * One-time deposit page for create_upload_link. The file is stored exactly like SAM's web app does
 * (read in its code on 2026-10-27): bucket "documents", path <client_id>/<type_document>_<timestamp>.<ext>,
 * signed link valid one year in file_url, document status "en_revision", uploaded_by_user_id, date_mise_a_jour.
 */
import type { Context, Hono } from "hono";
import type { Logger } from "../logger.js";
import type { UploadClaims } from "../mcp/actions.js";
import type { SamSession } from "../mcp/tools.js";
import { SamApiError, ValidationError } from "../sam/errors.js";
import type { TokenSigner, UsedTokenRegistry } from "../security/signer.js";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const SIGNED_URL_SECONDS = 3600 * 24 * 365;
const ALLOWED = new Map([
  ["pdf", "application/pdf"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
]);

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

const STYLE = `
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --text:#1d2433; --muted:#5b6475; --accent:#2f5bea; --ok:#067647; --danger:#b42318; --border:#d9dde5; }
  @media (prefers-color-scheme: dark) { :root { --bg:#12151b; --card:#1b2029; --text:#e8ebf1; --muted:#9aa3b5; --accent:#7a9bff; --ok:#6ce9a6; --danger:#ff8a80; --border:#2c3340; } }
  * { box-sizing:border-box; } body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text); font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; padding:16px; }
  main { width:100%; max-width:460px; background:var(--card); border:1px solid var(--border); border-radius:12px; padding:28px; }
  h1 { font-size:1.2rem; margin:0 0 6px; } p { color:var(--muted); margin:0 0 16px; } .doc { color:var(--text); font-weight:600; }
  label.drop { display:block; border:2px dashed var(--border); border-radius:10px; padding:28px 16px; text-align:center; cursor:pointer; color:var(--muted); }
  input[type=file] { width:100%; margin-top:12px; color:var(--text); }
  button { width:100%; margin-top:16px; padding:11px; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:#fff; font-size:1rem; cursor:pointer; }
  .ok { color:var(--ok); font-weight:600; } .error { color:var(--danger); font-weight:600; }`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

export interface UploadDeps {
  signer: TokenSigner;
  usedUploads: UsedTokenRegistry;
  samFor: (principal: string) => Promise<SamSession>;
  logger: Logger;
}

export function registerUploadRoutes(app: Hono, deps: UploadDeps): void {
  const verify = (token: string) => deps.signer.verify<UploadClaims & { jti?: string; exp?: number }>("upload", token);
  const expired = (c: Context) =>
    c.html(page("Lien expiré", `<h1>Lien expiré ou déjà utilisé</h1><p>Demandez un nouveau lien de dépôt à Claude.</p>`), 410, HEADERS);

  app.get("/upload/:token", async (c) => {
    const claims = await verify(c.req.param("token"));
    if (!claims) return expired(c);
    return c.html(
      page(
        "Déposer un document",
        `<h1>Déposer un document dans SAM</h1>
         <p>Document : <span class="doc">${esc(claims.libelle)}</span></p>
         <form method="post" enctype="multipart/form-data">
           <label class="drop" for="file">Choisissez le fichier (PDF, JPG ou PNG, 20 Mo max)<input id="file" name="file" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" required></label>
           <button type="submit">Déposer dans le dossier</button>
         </form>`,
      ),
      200,
      HEADERS,
    );
  });

  app.post("/upload/:token", async (c) => {
    const claims = await verify(c.req.param("token"));
    if (!claims) return expired(c);
    const fail = (msg: string, status: 400 | 413 | 502 = 400) =>
      c.html(page("Dépôt impossible", `<h1>Dépôt impossible</h1><p class="error">${esc(msg)}</p><p>Revenez en arrière pour réessayer.</p>`), status, HEADERS);

    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > MAX_UPLOAD_BYTES + 64 * 1024) return fail("Fichier trop volumineux (20 Mo maximum).", 413);
    const form = await c.req.parseBody().catch(() => undefined);
    const file = form?.file;
    if (!(file instanceof File) || file.size === 0) return fail("Aucun fichier reçu.");
    if (file.size > MAX_UPLOAD_BYTES) return fail("Fichier trop volumineux (20 Mo maximum).", 413);
    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    const contentType = ALLOWED.get(ext);
    if (!contentType) return fail("Format non supporté. Utilisez PDF, JPG ou PNG.");
    if (!claims.jti || !deps.usedUploads.consume(claims.jti, claims.exp ?? 0)) return expired(c);

    try {
      const sam = await deps.samFor(claims.sub);
      if (!sam.direct) throw new ValidationError("Dépôt indisponible sur ce serveur");
      const prefix = claims.titre ? "custom" : claims.type_document;
      const path = `${claims.client_id}/${prefix}_${Date.now()}.${ext}`;
      await sam.direct.upload("documents", path, await file.arrayBuffer(), contentType);
      const fileUrl = await sam.direct.signedUrl("documents", path, SIGNED_URL_SECONDS);
      const now = new Date().toISOString();
      const userId = (await sam.userId()) ?? null;
      if (claims.document_id) {
        await sam.client.update("documents", claims.document_id, { file_url: fileUrl, status: "en_revision", uploaded_by_user_id: userId, date_mise_a_jour: now });
      } else {
        const client = await sam.client.get("clients", claims.client_id);
        await sam.client.create("documents", {
          client_id: claims.client_id,
          distributeur_id: client.distributeur_id ?? null,
          type_document: "custom",
          file_url: fileUrl,
          status: "en_revision",
          remarks: `Document personnalisé: ${claims.titre ?? ""}`,
          uploaded_by_user_id: userId,
          date_mise_a_jour: now,
        });
      }
      deps.logger.info("upload.done", { account: claims.sub, size_kb: Math.round(file.size / 1024) });
      return c.html(
        page("Document déposé", `<h1 class="ok">Document déposé</h1><p><span class="doc">${esc(claims.libelle)}</span> est maintenant dans le dossier du client, au statut « en révision ». Vous pouvez fermer cette page.</p>`),
        200,
        HEADERS,
      );
    } catch (err) {
      deps.logger.warn("upload.failed", { account: claims.sub, error: err });
      const msg = err instanceof SamApiError || err instanceof ValidationError ? err.message : "Erreur inattendue";
      return fail(`${msg}. Demandez un nouveau lien à Claude.`, 502);
    }
  });
}
