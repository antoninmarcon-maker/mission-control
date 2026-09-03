# Mission Control — protocole de validation audit/hardening

Date de référence : 2 septembre 2026

Branche : `fix/audit-hardening`

PR : <https://github.com/antoninmarcon-maker/mission-control/pull/3>

## Accès de démonstration isolé

Ces identifiants sont synthétiques, publics et réservés au harnais local. Ils ne donnent accès à aucun compte ni secret existant.

- URL : `http://127.0.0.1:3005/login`
- Utilisateur : `auditadmin`
- Mot de passe : `MissionControl-Audit-2026!`
- Clé API de test : `mc-audit-api-key-2026-test-only`

L'environnement n'est pas laissé en fonctionnement. Pour le recréer depuis le worktree :

```bash
cd /Users/antoninmarcon/Documents/worktrees/mission-control/audit-hardening
pnpm install --frozen-lockfile
pnpm build
AUTH_USER='auditadmin' \
AUTH_PASS='MissionControl-Audit-2026!' \
API_KEY='mc-audit-api-key-2026-test-only' \
GITHUB_TOKEN='' \
MISSION_CONTROL_TEST_MODE=1 \
node scripts/e2e-openclaw/start-e2e-server.mjs --mode=local
```

Arrêt : `Ctrl-C`. Le harnais recrée ses données synthétiques sous `.tmp/e2e-openclaw/local` à chaque lancement.

## Protocole manuel

### 1. Authentification

1. Ouvrir l'URL de démonstration.
2. Essayer `wrong-audit-password` : la réponse doit être 401 et l'interface doit afficher « Invalid credentials ».
3. Se connecter avec les identifiants ci-dessus : le tableau de bord doit apparaître.
4. Si l'assistant apparaît, cliquer « Skip setup ».
5. Ouvrir un nouvel onglet sur `/` : l'assistant ne doit pas se rouvrir.
6. Le redémarrage volontaire de l'assistant reste disponible depuis Settings.

### 2. Accessibilité et responsive

1. Sur `/login`, vérifier la présence d'un unique `main` et d'un `h1`.
2. Sur `/`, vérifier un unique `h1` « Mission Control overview ».
3. Au clavier, presser `Tab` depuis le haut de page : « Skip to main content » doit être le premier focus.
4. Tester le zoom navigateur à 200 % : le zoom doit rester autorisé et les contrôles utilisables.
5. Tester 1440 × 1000 puis 390 × 844 : aucun débordement horizontal.
6. Vérifier que chaque bouton visible possède un nom accessible et une cible d'au moins 24 × 24 px.

### 3. Dégradation des intégrations optionnelles

Après connexion, ces requêtes doivent répondre 200 même lorsque la source facultative est absente :

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -H 'x-api-key: mc-audit-api-key-2026-test-only' 'http://127.0.0.1:3005/api/github?action=stats'
curl -sS -o /dev/null -w '%{http_code}\n' -H 'x-api-key: mc-audit-api-key-2026-test-only' 'http://127.0.0.1:3005/api/openclaw/doctor'
curl -sS -o /dev/null -w '%{http_code}\n' -H 'x-api-key: mc-audit-api-key-2026-test-only' 'http://127.0.0.1:3005/api/memory/graph?agent=all'
curl -sS -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:3005/robots.txt'
```

Résultat attendu : quatre lignes `200`. Le navigateur ne doit afficher aucune erreur inattendue.

### 4. Sécurité

1. Vérifier que `/robots.txt` contient `User-Agent: *` et `Disallow: /`.
2. Vérifier les en-têtes de `/login` : CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, Referrer-Policy, Permissions-Policy et HSTS.
3. Vérifier qu'une API sans session ni clé retourne 401.
4. Vérifier qu'un mauvais mot de passe retourne 401, puis que les tentatives répétées déclenchent 429.

## Matrice automatisée

```bash
pnpm audit --audit-level moderate
pnpm audit --prod --audit-level moderate
pnpm lint
pnpm typecheck
pnpm test
pnpm api:parity
pnpm test:security-shell
pnpm build
pnpm artifact:check
pnpm test:e2e
```

Critères de sortie :

- aucun avis de sécurité connu ;
- lint sans erreur ni warning ;
- typecheck vert ;
- 182 fichiers / 1 578 tests Vitest verts ;
- parité API : 262 opérations de routes, 253 documentées, 12 exceptions approuvées ;
- build de 116 routes et artefact standalone valide ;
- 521 tests Playwright verts ;
- audit navigateur : zéro contrôle sans nom, zéro cible visible sous 24 px, zéro overflow, zéro réponse inattendue ;
- Lighthouse login : accessibilité 100, bonnes pratiques 100, performance au moins 90.

Le score SEO est volontairement abaissé par `Disallow: /` : Mission Control est une application privée authentifiée et ne doit pas être indexée.

## Validation de la clé API

```bash
curl -sS \
  -H 'x-api-key: mc-audit-api-key-2026-test-only' \
  'http://127.0.0.1:3005/api/status?action=dashboard' | jq .
```

Ne jamais remplacer ces valeurs par des identifiants réels dans un ticket, une capture, un commit ou un message.
