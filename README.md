# Connecteur MCP SAM pour Claude.ai

Serveur MCP distant (transport **Streamable HTTP**) qui permet à Claude.ai de consulter et de modifier le CRM **SAM** depuis une conversation, en complément des connecteurs Google Workspace (Gmail, Calendar, Drive) déjà disponibles dans Claude.

```
Claude.ai ──HTTPS + OAuth 2.1──▶ Serveur MCP SAM (Cloudflare Worker) ──HTTPS + JWT SAM──▶ API SAM (Supabase Edge Functions)
```

- **Plusieurs comptes SAM** (2 aujourd'hui, 10 max) : chaque personne a son propre *mot de passe de connecteur*. Elle le saisit une fois, quand elle connecte Claude.ai ; il désigne son compte SAM.
- Claude.ai s'authentifie auprès du **serveur MCP** avec OAuth 2.1 ; le jeton obtenu est lié au compte de la personne.
- Le serveur MCP s'authentifie auprès de **SAM** avec les identifiants de ce compte, stockés côté serveur. Chaque compte a sa propre session SAM et ses propres droits. Le JWT SAM ne quitte jamais le serveur.
- Les deux authentifications sont indépendantes : Claude ne voit jamais les identifiants SAM.

## Sommaire

1. [Choix d'hébergement](#choix-dhébergement)
2. [Outils exposés](#outils-exposés)
3. [Sécurité](#sécurité)
4. [Installation locale](#installation-locale)
5. [Tests](#tests)
6. [Déploiement sur Cloudflare Workers](#déploiement-sur-cloudflare-workers)
7. [Connecter Claude.ai](#connecter-claudeai)
8. [Variables d'environnement](#variables-denvironnement)
9. [Passer aux vraies données SAM](#passer-aux-vraies-données-sam)
10. [Alternative : Render / Node](#alternative--render--node)
11. [Limites connues](#limites-connues)

## Choix d'hébergement

**Cloudflare Workers**, pour ces raisons :

- HTTPS public immédiat (`*.workers.dev` ou domaine personnalisé), compatible avec les connecteurs personnalisés de Claude.ai.
- Runtime Web standard : le SDK MCP officiel fournit `WebStandardStreamableHTTPServerTransport`, utilisé tel quel.
- Secrets chiffrés gérés par `wrangler secret`, aucune machine à maintenir, offre gratuite suffisante pour quelques utilisateurs.
- Pas de démarrage à froid notable ; région au plus près de l'API SAM (Supabase eu-central).

Le même code tourne aussi sous Node.js (`src/node.ts`), ce qui permet un hébergement sur Render ou tout hébergeur Node (voir plus bas). Les Supabase Edge Functions n'ont pas été retenues : déployer dans le projet Supabase du CRM mélangerait le connecteur et la production SAM, et nous n'avons pas accès à ce projet.

## Outils exposés

| Domaine | Lecture | Écriture (selon `SAM_WRITE_MODE`) |
|---|---|---|
| Clients | `search_clients`, `get_client` | `create_client`, `update_client` |
| Prospects | `search_leads`, `get_lead` | `create_lead`, `update_lead` |
| Commercial | `list_commerciaux`, `list_distributeurs`, `list_products`, `get_crm_stats` | `create_commercial`, `update_commercial` (champ `user_id` refusé), `create_distributeur`, `update_distributeur`, `create_product`, `update_product` |
| Tâches | `list_tasks` | `create_task`, `update_task` |
| Rendez-vous | `list_appointments` | `create_appointment`, `update_appointment` |
| Documents, notifications | `list_documents`, `get_document`, `list_notifications` | `create_document`, `update_document`, `update_notification` |
| Commentaires | `list_client_comments`, `list_lead_comments` | `add_client_comment`, `add_lead_comment`, `update_client_comment`, `update_lead_comment` |
| Produits d'un client | `list_client_products` | `add_client_product`, `update_client_product` |
| Suppression (toutes les fiches) | — | `delete_record` |
| Actions groupées | — | `batch_write` : jusqu'à 50 créations/modifications/suppressions en un appel (un seul clic d'approbation), toutes vérifiées avant la première écriture, puis exécutées dans l'ordre sans retour arrière ; `stop_on_error` pour s'arrêter à la première erreur |
| Schéma | `get_crm_schema` | — |
| Actions du CRM | — | `convert_lead` (prospect → client ou distributeur, logique du bouton du CRM), `set_reminder` (date de relance, 9 h heure de Paris) |
| Modèles d'email du CRM | `list_email_templates`, `preview_template_email` | `send_template_email` (variables `{{client.nom}}`…, copies du modèle, commercial en copie, historique de la fiche) |
| Fichiers | — | `create_upload_link` : lien à usage unique (6 h) où l'utilisateur dépose un PDF/JPG/PNG (20 Mo), rangé comme le CRM |
| Comptes commerciaux | — | `create_commercial_account` : accès CRM + envoi des identifiants (toujours confirmé, mot de passe jamais visible) |
| Emails (avec Gmail) | `prepare_email` : fiche, commercial, tâches, rendez-vous + recherches Gmail à lancer | `send_email` (si `SAM_SEND_EMAIL=true`) |

Paramètres communs des listes : `search`, `filters` (`[{field, op, value}]` avec `op` = `eq`, `not`, `gte`, `lte`, `like`, `null`), `fields` (projection), `limit` (1-50, défaut 20), `offset`.

Les écritures prennent `data` : un objet `{champ: valeur}` dont **chaque nom de champ est vérifié contre les champs réels de SAM**. `id`, `created_at`, `updated_at`, `deleted_at` et `deleted_by` sont toujours refusés. Les champs sont ceux décrits par l'API ou, à défaut, observés sur les enregistrements réels, et les champs inconnus sont alors refusés. Si aucun champ n'est connu (entité vide ou illisible), l'écriture est permise avec un avertissement dans l'aperçu, et SAM valide lui-même les noms de champs.

Email : `send_email` envoie via l'expéditeur du CRM (`POST /send-email`, champs `to`, `subject`, `html`, vérifiés le 26/10/2026), un destinataire à la fois. Il est désactivé tant que `SAM_SEND_EMAIL` ne vaut pas `true`. L'endpoint n'accepte pas de nom de modèle : les modèles du CRM doivent être fournis en HTML.

Volontairement absents : création de comptes utilisateurs (aucun endpoint documenté), requête HTTP générique.

## Fonctions du site SAM (hors API officielle)

Avec l'accord de SAM (27/10/2026), le connecteur reprend certaines fonctions du site du CRM (`https://sam.classicall.fr`) que l'API `/crm-api` ne propose pas. Leur logique a été lue dans le code public du site et elles passent par les mêmes chemins, avec le compte de l'utilisateur connecté (mêmes droits) :

| Fonction | Chemin utilisé |
|---|---|
| Modèles d'email, infos SAM | lecture des tables `email_templates`, `email_template_attachments`, `sam_contact_info` |
| Historique des emails | écriture dans `email_logs` |
| Dépôt de fichiers | stockage `documents/<client>/<type>_<horodatage>.<ext>`, lien signé 1 an, document « en révision » |
| Comptes commerciaux | fonctions `create-user-account` et `send-access-credentials-commercial` |
| Commentaires, notifications | lecture directe quand `/crm-api` renvoie son erreur `deleted_at` |

Ces fonctions nécessitent `SAM_SUPABASE_ANON_KEY` (clé publique du site, envoyée par `npm run secrets:push`). Sans elle, elles ne sont pas exposées. Si SAM modifie son site, ces fonctions peuvent devoir être adaptées.

## Sécurité

| Exigence | Mise en œuvre |
|---|---|
| Authentification du serveur MCP indépendante de SAM | OAuth 2.1 (découverte RFC 9728/8414, enregistrement dynamique RFC 7591, code + PKCE S256, refresh token). La personne saisit son `SAM_ACCOUNT_<N>_CONNECTOR_PASSWORD` sur la page de consentement. Jeton statique optionnel par compte (`SAM_ACCOUNT_<N>_STATIC_TOKEN`) pour Claude Code / tests. |
| Aucun secret dans le code | Tout passe par variables d'environnement / `wrangler secret`. `.env`, `.dev.vars` ignorés par git. |
| JWT SAM géré côté serveur | Connexion paresseuse, cache jusqu'à 60 s avant `expires_at`, connexion unique partagée entre requêtes concurrentes, reconnexion + **une seule** nouvelle tentative sur 401. |
| Plusieurs comptes | Le `sub` du jeton MCP est l'id du compte ; `EnvCredentialsProvider` (`src/sam/credentials.ts`) le relie aux identifiants SAM. Une session SAM, un cache et des droits par compte. Un jeton de confirmation d'un compte est refusé pour un autre. Retirer un compte de la configuration invalide ses jetons. Mots de passe de connecteur uniques et différents des mots de passe SAM (vérifié au démarrage). |
| Données limitées | 50 résultats max, textes tronqués (300 car. en liste, 2000 en détail), clés sensibles retirées (`password`, `token`, `secret`, `api_key`, `hash`…), réponse plafonnée à 40 000 caractères. |
| Permissions CRM respectées | Chaque appel porte le JWT du compte SAM : rôle SAM et règles côté CRM s'appliquent. Les 403 sont remontés clairement. |
| Suppression | Un seul outil, `delete_record`, qui relit la fiche avant de la supprimer (une fiche inexistante n'est jamais supprimée). Immédiate en mode `direct` ; aperçu + confirmation en mode `confirm` ; absente en mode `disabled`. |
| Contrôle humain avant modification | Mode `confirm` (défaut) : 1er appel = aperçu sans écriture (avec valeurs actuelles pour une modification) + `confirmation_token` signé, lié aux paramètres exacts, valable 10 min, à usage unique. Annotations MCP `readOnlyHint` / `destructiveHint` pour que Claude.ai demande l'approbation. Voir [Connecter Claude.ai](#connecter-claudeai) pour régler l'approbation manuelle. |
| Email sous contrôle | `send_email` est absent tant que `SAM_SEND_EMAIL=true` n'est pas défini : un seul destinataire, adresse validée, destinataire et contenu jamais journalisés. |
| Logs sans secrets | Logger JSON avec masquage des clés sensibles, des JWT, des en-têtes Bearer et des valeurs de secrets configurées. Les chaînes de recherche (données personnelles) ne sont pas journalisées. |
| Page de connexion | CSP stricte, `frame-ancestors 'none'`, jeton de requête signé (anti-CSRF), verrouillage après 5 échecs en 15 min (par instance). |
| Redirections OAuth | Seuls les hôtes de `OAUTH_ALLOWED_REDIRECT_HOSTS` (défaut : `claude.ai`, `claude.com`, `localhost`) sont acceptés, en HTTPS sauf localhost. |

**Note sur le contrôle humain.** Le mécanisme aperçu/confirmation garantit que rien n'est écrit sans un second appel portant exactement les paramètres montrés. Il ne peut pas, à lui seul, prouver que c'est l'humain qui a dit « oui ». La garantie forte vient du réglage d'approbation par outil dans Claude.ai (« demander à chaque fois » pour les outils d'écriture), qui affiche chaque appel avant exécution. Activez les deux.

## Installation locale

Prérequis : Node.js ≥ 20 (testé avec Node 25), npm.

```bash
npm install
cp .dev.vars.example .dev.vars   # pour wrangler dev
cp .env.example .env             # pour le serveur Node
npm run secret:generate          # une valeur pour MCP_AUTH_SECRET, une par SAM_ACCOUNT_<N>_STATIC_TOKEN
```

Lancer le serveur :

| Commande | Usage |
|---|---|
| `npm run dev:mock` | Serveur Node sur http://127.0.0.1:8787 avec l'API SAM **simulée** (sans `.env` : un compte, mot de passe de consentement de dev `dev-password-123` ; avec `.env` : les comptes déclarés, chacun avec un utilisateur simulé) |
| `npm run dev` | `wrangler dev` (runtime Workers local) avec `.dev.vars` |
| `npm run dev:node` | Serveur Node avec `.env` (vraie API si `SAM_MOCK=false`) |

Essayer avec MCP Inspector :

```bash
npx @modelcontextprotocol/inspector
# Transport : Streamable HTTP, URL : http://127.0.0.1:8787/mcp
# Authentification : en-tête "Authorization: Bearer <SAM_ACCOUNT_N_STATIC_TOKEN>" ou flux OAuth
```

## Tests

```bash
npm test            # Vitest, 135 tests, API SAM simulée, aucun accès réseau
npm run env:check   # vérifie le .env sans afficher les secrets
npm run e2e         # bout en bout en lecture seule sur la vraie API (serveur lancé)
npm run typecheck   # tsc strict
npm run check       # les deux
npm run deploy:dry  # bundle Cloudflare sans déployer
npm run smoke       # test HTTP en lecture seule d'un serveur lancé (MCP_URL, MCP_TOKEN)
```

Couverture : connexion MCP et découverte des outils, absence d'outils de suppression / email / HTTP ; authentification SAM (cache, concurrence, 401 → reconnexion unique, renouvellement avant expiration, identifiants refusés, réseau) ; recherche client, filtres, projection ; création de prospect et de tâche ; flux aperçu/confirmation (rejeu, paramètres modifiés, jeton falsifié) ; validation des paramètres ; erreurs SAM (500, 403 rôle, schéma illisible) ; OAuth complet (DCR, PKCE, mauvais mot de passe, verrouillage, redirections interdites, refresh, client confidentiel) ; refus des accès non autorisés ; absence de secrets dans les logs ; point d'entrée Worker ; plusieurs comptes (bon compte SAM selon le mot de passe, jetons statiques par compte, confirmation non transférable, droits séparés, compte retiré = jetons refusés, validation de la configuration).

## Déploiement sur Cloudflare Workers

Prérequis : un compte Cloudflare (gratuit) et le `.env` rempli (`npm run env:check` doit afficher « Configuration valide »).

```bash
npx wrangler login        # ouvre le navigateur, autoriser Wrangler
npm run deploy            # typecheck + tests + wrangler deploy → affiche l'URL https://sam-mcp.<sous-domaine>.workers.dev
npm run secrets:push      # envoie les secrets du .env à Cloudflare (MCP_AUTH_SECRET, SAM_ACCOUNT_<N>_*), actifs immédiatement
```

> Le premier `wrangler deploy` peut demander de choisir un sous-domaine `workers.dev` : en choisir un (ex. le nom de l'entreprise).
> Entre le déploiement et l'envoi des secrets, le serveur répond « server_misconfigured » : c'est normal.

Ensuite :

1. Dans `wrangler.toml` > `[vars]`, décommenter `MCP_PUBLIC_URL` avec l'URL obtenue, puis `npm run deploy`.
2. Vérifier : `MCP_URL=https://sam-mcp.<sous-domaine>.workers.dev npm run e2e` (lecture seule, utilise les `STATIC_TOKEN` du `.env`).
3. `SAM_WRITE_MODE` vaut `direct` dans `wrangler.toml` (choix du propriétaire, pour la rapidité) : créations, modifications et suppressions sont immédiates. `confirm` rétablit l'aperçu + confirmation ; `disabled` repasse en lecture seule. Redéployer après changement.
4. Recommandé : règle de limitation de débit Cloudflare (WAF) sur `POST /authorize` et `POST /token`.

Révoquer tous les accès : changer `MCP_AUTH_SECRET` dans `.env`, puis `npm run secrets:push` — tous les jetons OAuth, codes et confirmations deviennent invalides. Révoquer une seule personne : `npx wrangler secret delete SAM_ACCOUNT_<N>_…` pour chacune de ses variables ; ses jetons sont alors refusés.

Logs en direct : `npx wrangler tail`.

## Connecter Claude.ai

1. Claude.ai → **Paramètres → Connecteurs → Ajouter un connecteur personnalisé** (sur un plan Team/Enterprise, un propriétaire l'ajoute d'abord dans les paramètres de l'organisation).
2. Nom : `SAM CRM`. URL : `https://sam-mcp.sam-crm.workers.dev/mcp` (instance actuelle). Laisser les champs OAuth avancés vides (enregistrement dynamique).
3. Chaque personne, depuis son propre compte Claude.ai, clique sur **Connecter** : la page « Autoriser l'accès au CRM SAM » s'ouvre. Elle saisit **son** mot de passe de connecteur (`SAM_ACCOUNT_<N>_CONNECTOR_PASSWORD`), puis **Autoriser**. Claude utilise ensuite son compte SAM, et seulement le sien.
4. Dans les réglages du connecteur, régler les outils d'écriture (`create_*`, `update_*`, `add_*_comment`) sur **demander l'approbation à chaque fois**.
5. Activer le connecteur dans une conversation (menu outils) et essayer : « Trouve le client Dupont et résume ses derniers commentaires ».

**Emails : SAM + Gmail.** Quand on demande un email à un client ou un prospect, Claude appelle `prepare_email` (fiche SAM, commercial, tâches, rendez-vous, adresses), puis lit avec le connecteur Gmail l'historique des échanges avec ce contact et un email du même type déjà envoyé. Il rédige ensuite dans le même style, crée un brouillon Gmail (ou envoie si on le demande) et met SAM à jour. Le connecteur SAM ne lit pas Gmail lui-même : c'est Claude qui combine les deux, d'où la nécessité d'activer les deux connecteurs dans la conversation.

Exemples combinés avec Google Workspace :

- « Liste mes rendez-vous SAM de la semaine et crée-les dans Google Agenda. »
- « Lis la fiche du prospect Bernard puis prépare un brouillon Gmail de relance. »
- « Crée une tâche SAM de rappel pour chaque client cité dans ce Google Doc. »

## Variables d'environnement

Voir [.env.example](.env.example) pour la liste commentée.

| Variable | Obligatoire | Description |
|---|---|---|
| `SAM_API_BASE_URL` | non | URL de base de l'API SAM (défaut : projet `eicajdaswdgfwgmaxene`) |
| `SAM_ACCOUNT_<N>_EMAIL`, `SAM_ACCOUNT_<N>_PASSWORD` | oui (sauf mock) | Identifiants SAM du compte N (rôle SAM) — **secrets** |
| `SAM_ACCOUNT_<N>_CONNECTOR_PASSWORD` | oui | Mot de passe saisi sur la page de consentement, ≥ 12 caractères, unique par compte — **secret** |
| `SAM_ACCOUNT_<N>_STATIC_TOKEN` | non | Jeton Bearer fixe du compte, ≥ 32 caractères — **secret** |
| `SAM_ACCOUNT_<N>_LABEL` | non | Nom du compte (logs, instructions de Claude) |
| `SAM_MOCK` | non | `true` = API simulée (dev/tests uniquement) |
| `SAM_WRITE_MODE` | non | `disabled`, `confirm` (défaut), `direct` |
| `SAM_SEND_EMAIL` | non | `true` active `send_email` et `send_template_email` (défaut `false`) |
| `SAM_SUPABASE_ANON_KEY` | non | Clé publique du site SAM : active modèles d'email, historique, dépôt de fichiers, comptes commerciaux — **secret** (`secrets:push`) |
| `SAM_REQUEST_TIMEOUT_MS` | non | Délai par appel SAM (défaut 15000) |
| `MCP_AUTH_SECRET` | oui | Clé de signature ≥ 32 caractères — **secret** |
| `MCP_PUBLIC_URL` | recommandé | URL publique (émetteur OAuth) |
| `OAUTH_ALLOWED_REDIRECT_HOSTS` | non | Hôtes de redirection OAuth autorisés |
| `LOG_LEVEL` | non | `debug`, `info` (défaut), `warn`, `error` |

Format « un seul compte » toujours accepté (sans `SAM_ACCOUNT_<N>_*`) : `SAM_EMAIL`, `SAM_PASSWORD`, `MCP_OWNER_PASSWORD`, `MCP_STATIC_TOKEN`.

## Passer aux vraies données SAM

1. `npm run env:check` : vérifie le `.env` sans afficher les secrets.
2. `npm run schema:fetch` (lecture seule) : montre les champs connus par entité.
3. `npm start`, puis dans un autre terminal `npm run e2e` : appelle tous les outils de **lecture** pour chaque compte ayant un `STATIC_TOKEN`, et affiche uniquement des statuts et des volumes.
4. Les écritures ont été validées sur la vraie API : la production est configurée en `SAM_WRITE_MODE=confirm`.

Résultats sur la vraie API (26/10/2026, 2 comptes) :

- Toutes les lectures fonctionnent (clients, prospects, tâches, rendez-vous, commerciaux, distributeurs, documents, produits, statistiques, recherche, filtres, fiches).
- `GET /crm-api/schema` ne renvoie que les noms d'entités : le connecteur **observe** donc les champs sur les enregistrements réels (`get_crm_schema` indique la source). Une entité sans enregistrement n'a pas de champ connu, et les écritures y sont refusées.
- Écritures validées le 26/10/2026 sur la vraie API, en mode `confirm` : création et modification d'un prospect et d'une tâche, refus des confirmations modifiées, rejouées ou venant d'un autre compte, refus de `deleted_at` et des champs inventés.
- **Bug de l'API SAM** : `client-comments`, `lead-comments` et `notifications` répondent `400 column <table>.deleted_at does not exist`. À corriger côté SAM ; les outils de commentaires et de notifications fonctionneront ensuite sans changement du connecteur.

## Alternative : Render / Node

`render.yaml` décrit un service web Node (`npm run build` puis `npm start`, `HOST=0.0.0.0`). Renseigner les secrets dans le tableau de bord Render. Le comportement est identique à la version Worker.

## Limites connues

- Format exact de `GET /crm-api/schema` et des réponses de liste non documenté : analyse tolérante, à valider avec les vrais identifiants.
- Mode sans état : pas de flux SSE serveur ni d'élicitation MCP (la confirmation passe par l'aperçu + jeton).
- Usage unique des codes OAuth et jetons de confirmation, et verrouillage après échecs : en mémoire, par instance Worker. Les durées de vie courtes (2 min / 10 min) limitent le risque ; un stockage KV ou Durable Object les rendrait globaux.
- Refresh tokens OAuth sans rotation révocable individuellement (révocation globale par changement de `MCP_AUTH_SECRET`).
- Comptes déclarés dans les variables d'environnement (10 max) : ajouter une personne demande de redéployer avec ses secrets.
