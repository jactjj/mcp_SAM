function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

const STYLE = `
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --text:#1d2433; --muted:#5b6475; --accent:#2f5bea; --danger:#b42318; --border:#d9dde5; }
  @media (prefers-color-scheme: dark) { :root { --bg:#12151b; --card:#1b2029; --text:#e8ebf1; --muted:#9aa3b5; --accent:#7a9bff; --danger:#ff8a80; --border:#2c3340; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text);
         font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; padding:16px; }
  main { width:100%; max-width:420px; background:var(--card); border:1px solid var(--border); border-radius:12px; padding:28px; }
  h1 { font-size:1.25rem; margin:0 0 8px; }
  p { color:var(--muted); margin:0 0 16px; }
  .client { color:var(--text); font-weight:600; word-break:break-all; }
  label { display:block; font-weight:600; margin-bottom:6px; }
  input[type=password] { width:100%; padding:10px 12px; border:1px solid var(--border); border-radius:8px; background:transparent; color:var(--text); font-size:1rem; }
  .row { display:flex; gap:8px; margin-top:16px; }
  button { flex:1; padding:10px 12px; border-radius:8px; border:1px solid var(--border); font-size:1rem; cursor:pointer; background:transparent; color:var(--text); }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  .error { color:var(--danger); font-weight:600; }
`;

export function consentPage(opts: { requestToken: string; clientName: string; redirectHost: string; error?: string }): string {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connexion SAM MCP</title><style>${STYLE}</style></head>
<body><main>
  <h1>Autoriser l'accès au CRM SAM</h1>
  <p><span class="client">${esc(opts.clientName)}</span> (${esc(opts.redirectHost)}) demande à lire et modifier vos données SAM via ce connecteur. Votre mot de passe détermine le compte SAM utilisé.</p>
  ${opts.error ? `<p class="error" role="alert">${esc(opts.error)}</p>` : ""}
  <form method="post" action="/authorize">
    <input type="hidden" name="request" value="${esc(opts.requestToken)}">
    <label for="password">Votre mot de passe du connecteur</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus>
    <div class="row">
      <button type="submit" name="action" value="deny">Refuser</button>
      <button type="submit" name="action" value="approve" class="primary">Autoriser</button>
    </div>
  </form>
</main></body></html>`;
}

export function errorPage(message: string): string {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connexion SAM MCP</title><style>${STYLE}</style></head>
<body><main><h1>Autorisation impossible</h1><p class="error">${esc(message)}</p></main></body></html>`;
}
