# CLAUDE.md — Connecteur MCP SAM

Mémoire technique du projet. Détails d'installation, de sécurité et de déploiement : [README.md](README.md).

## A. Présentation

- **Objectif** : serveur MCP distant permettant à Claude.ai de lire et modifier le CRM SAM depuis une conversation, en complément des connecteurs Google Workspace existants (non recréés ici).
- **Flux** : Claude.ai → (HTTPS, OAuth 2.1, Streamable HTTP) → ce serveur `/mcp` → (HTTPS, JWT SAM) → API SAM `https://eicajdaswdgfwgmaxene.supabase.co/functions/v1`.
- **Deux authentifications indépendantes** : Claude.ai ↔ serveur MCP (OAuth ; le mot de passe de connecteur saisi désigne le compte) ; serveur ↔ SAM (email/mot de passe SAM du compte, côté serveur uniquement).
- **Plusieurs comptes SAM** (2 en usage, 10 max) : `SAM_ACCOUNT_<N>_*`. Le `sub` des jetons MCP = id du compte ; une session SAM, un cache et des droits par compte.
- **Périmètre v1** : lecture + création/modification avec contrôle humain, pour chaque compte déclaré. Pas de suppression, pas d'envoi d'email, pas d'outil HTTP générique.

## B. Architecture

Stack : TypeScript strict (ESM, NodeNext), `@modelcontextprotocol/sdk` 1.32 (`McpServer` + `WebStandardStreamableHTTPServerTransport`, mode sans état, réponses JSON), Zod 4, Hono 4, jose 6, Cloudflare Workers (wrangler 4), Node via `@hono/node-server`, Vitest 4.

```
src/
  worker.ts          Entrée Cloudflare Workers (cache de l'app par configuration)
  node.ts            Entrée Node (dev, Render) ; charge .env
  app.ts             App Hono : CORS, /health, routes OAuth, /mcp (auth Bearer → serveur MCP par requête)
  config.ts          Lecture/validation des variables (comptes SAM_ACCOUNT_<N>_* ou format 1 compte), configSecrets()
  logger.ts          Logger JSON avec masquage (clés sensibles, JWT, Bearer, secrets connus)
  sam/
    entities.ts      Liste fermée des entités, opérateurs de filtre, regex champ/id
    auth.ts          SamTokenManager : login /crm-api-auth, cache jusqu'à expires_at - 60 s, single-flight
    client.ts        SamClient : list/get/create/update/stats/schema (PAS de delete), retry unique sur 401
    schema.ts        normalizeSchema + inferFields ; SchemaRegistry : champs déclarés, sinon observés sur 25 enregistrements réels (cache 10 min)
    credentials.ts   EnvCredentialsProvider : id de compte → identifiants SAM
    errors.ts        SamApiError / ValidationError (messages sûrs)
  mcp/
    server.ts        createMcpServer : instructions + validateur CfWorker (pas d'Ajv sur Workers)
    tools.ts         Catalogue déclaratif LIST_TOOLS / GET_TOOLS / WRITE_TOOLS + get_crm_stats, get_crm_schema
    output.ts        Limitation des sorties (troncature, clés sensibles retirées, 40 000 car. max)
  oauth/
    routes.ts        Métadonnées RFC 9728/8414, /register (DCR), /authorize (mot de passe → compte), /token, authenticateBearer
    page.ts          HTML de consentement (CSP stricte)
  security/signer.ts TokenSigner (JWT HS256, une clé dérivée par usage), safeEqual, canonicalJson, UsedTokenRegistry
  mock/sam-mock.ts   API SAM simulée en mémoire — CHAMPS FICTIFS, tests/dev uniquement
test/                Vitest (mcp, oauth, accounts, sam-auth, logging, schema, worker) + helpers.ts (setup, setupMulti)
scripts/             check-env.ts, fetch-schema.ts, e2e-readonly.ts (tous les outils de lecture, chaque compte), smoke.ts
```

**Client SAM** : chaque appel récupère le JWT via `SamTokenManager`. Sur 401 : `invalidate(token)`, reconnexion, une seule nouvelle tentative ; second 401 → `auth_failed`. Les réponses de liste sont normalisées (`[]`, `{data}`, `{items}`, `{<entité>}` + `count/total`).

**Auth MCP** : tout est sans état et signé avec des clés dérivées de `MCP_AUTH_SECRET` (usages : client, authreq, code, access 1 h, refresh 30 j, confirm 10 min). `client_id` = JWT décrivant le client. Sur `/authorize`, le mot de passe saisi est comparé à tous les `CONNECTOR_PASSWORD` (temps constant) et fixe `sub`. Un jeton dont le compte n'est plus configuré est refusé. `STATIC_TOKEN` optionnel par compte accepté comme Bearer.

**Outils** : définis de façon déclarative dans `tools.ts`. Les noms de champs ne sont jamais codés en dur. L'API réelle `GET /crm-api/schema` ne renvoie que la liste des entités (`{entities: [noms], description}`) : les champs sont donc **observés** sur les enregistrements réels (`inferFields`). Écritures : champs observés uniquement, refus si aucun champ connu. Lectures : filtres vérifiés si les champs sont connus, sinon SAM valide la colonne (400 « column … does not exist »). `id`, `created_at`, `updated_at`, `deleted_at`, `deleted_by` interdits en écriture (`deleted_*` = suppression logique SAM). En mode `confirm`, une écriture sans `confirmation_token` renvoie un aperçu ; le jeton est lié (SHA-256 canonique) à l'outil, l'entité, l'id, le compte et les données, et n'est utilisable qu'une fois.

## C. Commandes

```bash
npm install              # dépendances
npm run dev:mock         # Node + API simulée, http://127.0.0.1:8787/mcp
npm run dev              # wrangler dev (lit .dev.vars)
npm run dev:node         # Node avec .env
npm run typecheck        # tsc --noEmit
npm test                 # vitest run
npm run check            # typecheck + tests
npm run build            # compile Node vers dist/ (hors worker.ts)
npm start                # node dist/node.js
npm run deploy:dry       # bundle Workers sans déployer
npm run secrets:push     # envoie les secrets du .env à Cloudflare (wrangler secret bulk, via stdin)
npm run deploy           # check + wrangler deploy
npm run env:check        # vérifie .env sans afficher les secrets
npm run e2e              # bout en bout LECTURE SEULE sur la vraie API (serveur lancé, STATIC_TOKEN par compte)
npm run smoke            # MCP_URL=… MCP_TOKEN=… test HTTP lecture seule
npm run schema:fetch     # lit le vrai schéma SAM (.env requis) ; -- --account=2, -- --save
npm run secret:generate  # génère une valeur aléatoire pour un secret
```

## D. Règles de développement

- Respecter le découpage existant (sam/ = accès API, mcp/ = outils, oauth/ = accès au serveur). Ajouter un outil = ajouter une entrée dans le catalogue de `tools.ts`.
- TypeScript strict, imports ESM avec extension `.js`. `npm run check` doit passer.
- Valider toutes les entrées avec Zod (bornes, regex champ/id) puis contre le schéma SAM.
- Ne jamais inventer de champ SAM ni coder en dur un nom de champ métier ; se fonder sur `/crm-api/schema` (le mock est fictif).
- Ne jamais journaliser de secret, de jeton, de corps de requête ni de terme de recherche ; passer par `logger`.
- Ne pas ajouter de suppression, d'envoi d'email ni d'outil HTTP générique sans décision explicite de l'utilisateur.
- Garder des descriptions d'outils claires, en français, avec annotations `readOnlyHint` / `destructiveHint` exactes.
- Ajouter ou adapter les tests à chaque évolution (`test/`), y compris le test « liste exacte des outils ».
- Aucune écriture réelle dans SAM (et aucun déploiement) sans autorisation explicite de l'utilisateur.

## E. Configuration

Variables (valeurs : voir `.env.example`, jamais ici) : `SAM_API_BASE_URL`, `SAM_MOCK`, `SAM_WRITE_MODE` (`disabled|confirm|direct`, défaut `confirm`), `SAM_REQUEST_TIMEOUT_MS`, `MCP_AUTH_SECRET`* (≥ 32), `MCP_PUBLIC_URL`, `OAUTH_ALLOWED_REDIRECT_HOSTS`, `LOG_LEVEL`, `PORT`/`HOST` (Node). Par compte N : `SAM_ACCOUNT_<N>_LABEL`, `_EMAIL`*, `_PASSWORD`*, `_CONNECTOR_PASSWORD`* (≥ 12, unique, ≠ mot de passe SAM), `_STATIC_TOKEN`* (optionnel, ≥ 32). Format 1 compte encore accepté : `SAM_EMAIL`, `SAM_PASSWORD`, `MCP_OWNER_PASSWORD`, `MCP_STATIC_TOKEN` (ne pas mélanger). * = secret.

- Local : `.env` (Node) ou `.dev.vars` (wrangler), tous deux ignorés par git. Production : `npx wrangler secret put <NOM>` ; variables non secrètes dans `wrangler.toml` `[vars]`.
- Auth SAM : `POST /crm-api-auth` {email, password} → `access_token` (1 h). Seul le rôle SAM a accès.
- Claude.ai : connecteur personnalisé pointant sur `https://<hôte>/mcp` ; OAuth découvert automatiquement ; chaque personne saisit son `CONNECTOR_PASSWORD`. Procédure : README § « Connecter Claude.ai ».

## F. État du projet (2026-10-26)

Testé :
- 87 tests automatisés verts (API simulée au format réel), typecheck strict OK, bundle Workers OK.
- **Écritures sur la vraie API (2026-10-26, accord de l'utilisateur)**, via le serveur MCP en mode `confirm` : create/update_lead (Arno), create/update_task (Lenny) OK ; aperçu sans écriture, confirmation modifiée / rejouée / d'un autre compte refusée, `deleted_at` et champ inventé refusés ; aperçus OK pour create/update_client et create/update_appointment ; add_client_comment refusé (champs inconnus).
- **Bout en bout sur la vraie API SAM, en lecture seule, pour les 2 comptes** (`npm run e2e`) : auth SAM, 17 outils de lecture, recherche, filtres, fiches, pagination (`{data, pagination: {total, limit, offset, has_more}}`), refus sans jeton / faux jeton, une seule connexion SAM par compte, aucun secret/email/JWT dans les logs.

Constat sur l'API SAM réelle :
- **Bug côté SAM** : `client-comments`, `lead-comments`, `notifications` renvoient 400 « column <table>.deleted_at does not exist » (l'API filtre sur une colonne absente). À corriger dans l'API SAM ; outils concernés inutilisables en attendant.
- `products` et `client-products` : vides (0 enregistrement) → champs inconnus, écritures impossibles sur ces entités (aucun outil d'écriture de toute façon).
- L'API exclut déjà les enregistrements supprimés ; elle accepte `limit` > 50 (le connecteur plafonne à 50).
- Les 2 comptes voient les mêmes volumes (rôle SAM complet pour chacun).

Non fait / à faire :
- Supprimer à la main dans SAM les 2 fiches de test créées le 2026-10-26 : prospect `cf4f9c69-baa6-40d6-b5a4-57d7368237e5` (« TEST MCP ») et tâche `e46a1c84-6b67-43e8-bcae-63d36bb1ea22`.
- **Non déployé** (Cloudflare : `wrangler login`, `npm run secrets:push`, `npm run deploy`). `wrangler.toml` est en `SAM_WRITE_MODE=confirm` (écritures validées, demandé par l'utilisateur).
- Dépôt GitHub : `https://github.com/jactjj/mcp_SAM` (public).
- Envoi d'email (`/send-email`) non implémenté volontairement.

Limitations : champs obligatoires inconnus (SAM les vérifie à la création) ; types déduits des valeurs observées ; usage unique des codes/confirmations et verrouillage du mot de passe en mémoire par instance ; refresh tokens révocables globalement ou en retirant le compte ; mode sans état (pas d'élicitation MCP).

## G. Reprise de session

1. Lire ce fichier, puis le README si besoin de détails.
2. Examiner le code concerné avant toute modification (`src/mcp/tools.ts` pour les outils, `src/sam/` pour l'API).
3. Respecter les conventions ci-dessus (strict, Zod, schéma réel, pas de secrets, français dans les messages).
4. Lancer `npm run check` (et `npm run deploy:dry` si le runtime Workers est touché) après chaque modification.
5. Mettre à jour ce fichier quand l'architecture, les commandes, les règles ou l'état du projet changent.
