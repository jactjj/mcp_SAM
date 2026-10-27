# CLAUDE.md — Connecteur MCP SAM

Mémoire technique du projet. Détails d'installation, de sécurité et de déploiement : [README.md](README.md).

## A. Présentation

- **Objectif** : serveur MCP distant permettant à Claude.ai de lire et modifier le CRM SAM depuis une conversation, en complément des connecteurs Google Workspace existants (non recréés ici).
- **Flux** : Claude.ai → (HTTPS, OAuth 2.1, Streamable HTTP) → ce serveur `/mcp` → (HTTPS, JWT SAM) → API SAM `https://eicajdaswdgfwgmaxene.supabase.co/functions/v1`.
- **Deux authentifications indépendantes** : Claude.ai ↔ serveur MCP (OAuth ; le mot de passe de connecteur saisi désigne le compte) ; serveur ↔ SAM (email/mot de passe SAM du compte, côté serveur uniquement).
- **Plusieurs comptes SAM** (2 en usage, 10 max) : `SAM_ACCOUNT_<N>_*`. Le `sub` des jetons MCP = id du compte ; une session SAM, un cache et des droits par compte.
- **Périmètre** : lecture, création, modification et suppression (`delete_record`) de toutes les entités SAM, avec contrôle humain, pour chaque compte déclaré. Pas d'envoi d'email ni de création de compte utilisateur (endpoints non vérifiés / inexistants), pas d'outil HTTP générique.

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
- Ne jamais inventer de champ SAM ; se fonder sur les champs réels (observés ou lus dans le code du site SAM pour `actions.ts`). Le mock est fictif, sauf les champs réels ajoutés pour les actions.
- Ne jamais journaliser de secret, de jeton, de corps de requête ni de terme de recherche ; passer par `logger`.
- Suppression : uniquement via `delete_record` (suit `SAM_WRITE_MODE` ; relit toujours la fiche avant). Pas d'envoi d'email ni d'outil HTTP générique sans décision explicite de l'utilisateur.
- Garder des descriptions d'outils claires, en français, avec annotations `readOnlyHint` / `destructiveHint` exactes.
- Ajouter ou adapter les tests à chaque évolution (`test/`), y compris le test « liste exacte des outils ».
- Aucune écriture réelle dans SAM (et aucun déploiement) sans autorisation explicite de l'utilisateur.

## E. Configuration

Variables (valeurs : voir `.env.example`, jamais ici) : `SAM_API_BASE_URL`, `SAM_MOCK`, `SAM_WRITE_MODE` (`disabled|confirm|direct`, défaut `confirm`), `SAM_SEND_EMAIL` (`true` active `send_email`), `SAM_REQUEST_TIMEOUT_MS`, `MCP_AUTH_SECRET`* (≥ 32), `MCP_PUBLIC_URL`, `OAUTH_ALLOWED_REDIRECT_HOSTS`, `LOG_LEVEL`, `PORT`/`HOST` (Node). Par compte N : `SAM_ACCOUNT_<N>_LABEL`, `_EMAIL`*, `_PASSWORD`*, `_CONNECTOR_PASSWORD`* (≥ 12, unique, ≠ mot de passe SAM), `_STATIC_TOKEN`* (optionnel, ≥ 32). Format 1 compte encore accepté : `SAM_EMAIL`, `SAM_PASSWORD`, `MCP_OWNER_PASSWORD`, `MCP_STATIC_TOKEN` (ne pas mélanger). * = secret.

- Local : `.env` (Node) ou `.dev.vars` (wrangler), tous deux ignorés par git. Production : `npx wrangler secret put <NOM>` ; variables non secrètes dans `wrangler.toml` `[vars]`.
- Auth SAM : `POST /crm-api-auth` {email, password} → `access_token` (1 h). Seul le rôle SAM a accès.
- Claude.ai : connecteur personnalisé pointant sur `https://<hôte>/mcp` ; OAuth découvert automatiquement ; chaque personne saisit son `CONNECTOR_PASSWORD`. Procédure : README § « Connecter Claude.ai ».

## F. État du projet (2026-10-26)

Testé :
- 135 tests automatisés verts (API simulée au format réel), typecheck strict OK, bundle Workers OK.
- **Écritures sur la vraie API (2026-10-26, accord de l'utilisateur)**, via le serveur MCP en mode `confirm` : create/update_lead (Arno), create/update_task (Lenny) OK ; aperçu sans écriture, confirmation modifiée / rejouée / d'un autre compte refusée, `deleted_at` et champ inventé refusés ; aperçus OK pour create/update_client et create/update_appointment ; add_client_comment refusé (champs inconnus).
- **Bout en bout sur la vraie API SAM, en lecture seule, pour les 2 comptes** (`npm run e2e`) : auth SAM, 17 outils de lecture, recherche, filtres, fiches, pagination (`{data, pagination: {total, limit, offset, has_more}}`), refus sans jeton / faux jeton, une seule connexion SAM par compte, aucun secret/email/JWT dans les logs.

Constat sur l'API SAM réelle :
- **Bug côté SAM** : `client-comments`, `lead-comments`, `notifications` renvoient 400 « column <table>.deleted_at does not exist » (l'API filtre sur une colonne absente). À corriger dans l'API SAM ; outils concernés inutilisables en attendant.
- `products` et `client-products` : vides (0 enregistrement) → champs inconnus, écritures impossibles sur ces entités (aucun outil d'écriture de toute façon).
- L'API exclut déjà les enregistrements supprimés ; elle accepte `limit` > 50 (le connecteur plafonne à 50).
- Les 2 comptes voient les mêmes volumes (rôle SAM complet pour chacun).

Non fait / à faire :
- **Déployé** le 2026-10-26 sur Cloudflare Workers : `https://sam-mcp.sam-crm.workers.dev` (endpoint MCP `/mcp`), `SAM_WRITE_MODE=direct` (demandé par le propriétaire le 2026-10-26 : pas de confirmation), 11 secrets (`npm run secrets:push`). `npm run e2e` contre la prod : 41 outils (24 d'écriture/suppression) ; 6 échecs = bug SAM commentaires/notifications.
- Dépôt GitHub : `https://github.com/jactjj/mcp_SAM` (public).
- Email : `POST /send-email` attend `to`, `subject`, `html` (découvert le 2026-10-26 par une requête vide, réponse 400 « Missing required fields: to, subject, html »). Outil `send_email` implémenté, **désactivé** (`SAM_SEND_EMAIL=false`) jusqu'à un envoi de test réel validé par l'utilisateur. Pas de nom de modèle côté API : les modèles du CRM sont à fournir en HTML.
- Outils ajoutés le 2026-10-26 à la demande de l'utilisateur (« le connecteur doit pouvoir agir ») : commerciaux (`user_id` bloqué), distributeurs, produits, documents, produits client, modification des commentaires et notifications, `delete_record`. `delete_record` validé sur la vraie API (suppression de la tâche de test, rejeu et jeton détourné refusés) ; les autres nouveaux outils sont testés en aperçu seulement. Entité sans champ connu : écriture permise avec avertissement, SAM valide les colonnes.
- Emails : `prepare_email` (lecture) rassemble fiche, commercial, distributeur, tâches, rendez-vous et propose les recherches Gmail ; les instructions serveur décrivent la méthode SAM + Gmail (historique du contact, email du même type déjà envoyé, brouillon par défaut, mise à jour SAM). Le serveur n'accède pas à Gmail : Claude combine les connecteurs.
- `batch_write` (2026-10-27, retour client « validation par lot ») : ≤ 50 opérations create/update/delete, validation complète avant toute écriture (mêmes règles que les outils unitaires : entités créables, `blockedFields`, champs gérés par SAM), exécution séquentielle sans retour arrière, un seul jeton en mode `confirm`.
- **Fonctions du site SAM** (2026-10-27, accord de SAM, logique lue dans le code public de https://sam.classicall.fr) : `src/sam/direct.ts` (listes fermées de tables, bucket, fonctions ; JWT utilisateur + `SAM_SUPABASE_ANON_KEY`), `src/mcp/actions.ts` (convert_lead, set_reminder, list/preview/send_template_email, create_upload_link, create_commercial_account), `src/mcp/templates.ts` (variables `{{groupe.champ}}`, signature, copies), `src/upload/routes.ts` (page `/upload/:token`). Pré-demande = `statut_sam = pre_demande` (SAM vérifie les documents bloquants). Relance = `next_reminder_at` à 9 h Paris. Pas d'app Google (refusée) : dépôt par lien. Lecture des commentaires/notifications en direct si `/crm-api` renvoie l'erreur `deleted_at`. Testé en lecture sur la prod (10 modèles réels, aperçu sur un vrai client, commentaires lus). Testé en écriture sur la prod (2026-10-27) : convert_lead identique au bouton (SAM crée seul les 9 documents), set_reminder, batch_write (nettoyage de 11 fiches). Reste à tester en prod après `npm run secrets:push` (clé publique) : envoi d'email type, dépôt de fichier, compte commercial.
- **Comptes utilisateurs SAM : impossible pour l'instant**, aucun endpoint documenté (les 12 entités n'incluent pas les utilisateurs). Nécessite un endpoint fourni par le développeur SAM ; ne pas en inventer.

Limitations : champs obligatoires inconnus (SAM les vérifie à la création) ; types déduits des valeurs observées ; usage unique des codes/confirmations et verrouillage du mot de passe en mémoire par instance ; refresh tokens révocables globalement ou en retirant le compte ; mode sans état (pas d'élicitation MCP).

## G. Reprise de session

1. Lire ce fichier, puis le README si besoin de détails.
2. Examiner le code concerné avant toute modification (`src/mcp/tools.ts` pour les outils, `src/sam/` pour l'API).
3. Respecter les conventions ci-dessus (strict, Zod, schéma réel, pas de secrets, français dans les messages).
4. Lancer `npm run check` (et `npm run deploy:dry` si le runtime Workers est touché) après chaque modification.
5. Mettre à jour ce fichier quand l'architecture, les commandes, les règles ou l'état du projet changent.
