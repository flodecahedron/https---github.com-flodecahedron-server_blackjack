# Serveur Casino Royale

Serveur WebSocket autoritaire pour le blackjack et la roulette américaine multijoueur. Les cartes, tirages, mises, actions, soldes et gains ne sont jamais calculés par le client.

## Déploiement Render avec Neon

Le fichier `render.yaml` à la racine du dépôt serveur décrit uniquement le Web Service. PostgreSQL est hébergé séparément chez Neon. Dans Render :

1. Ouvrir **New > Blueprint** et sélectionner le dépôt Git.
2. Vérifier que le Blueprint détecté est `render.yaml`, puis créer le service.
3. Renseigner les variables secrètes demandées par le Blueprint :
   - `DATABASE_URL` : chaîne de connexion Neon avec `sslmode=require` ;
   - `GOOGLE_WEB_CLIENT_ID` : ID du client OAuth de type **Application Web** ;
   - `ABUSE_HASH_SECRET` est généré automatiquement ;
   - `ALLOW_GUEST_AUTH` reste à `false` en production.
4. Attendre que le Web Service affiche `Live`.
5. Ouvrir `https://<nom-du-service>.onrender.com/health`. La réponse doit contenir `"persistence":"postgres"`.
6. Copier l'adresse du service sous la forme `wss://<nom-du-service>.onrender.com` dans `DEFAULT_URL` du fichier local `godot/scripts/network.gd`, puis reconstruire l'APK.

Ne définissez pas `PORT` : Render l'injecte. Le service utilise `npm ci --omit=dev`, `npm start` et `/health` comme health check. Neon doit rester la seule base configurée : le Blueprint ne crée aucune base Render. Le dossier local `node_modules` n'est jamais envoyé ; Render reconstruit uniquement les dépendances de production à partir de `package-lock.json`.

Les migrations SQL versionnées du dossier `migrations/` sont appliquées automatiquement et une seule fois au démarrage. Elles créent notamment `blackjack_players`, `blackjack_auth_accounts`, `blackjack_abuse_events` et le journal financier `blackjack_chip_ledger`.

## Économie et jetons de secours

Les variations de solde produites par une room sont enregistrées de façon idempotente dans `blackjack_chip_ledger`. Les mises contre un croupier humain sont conservées dans le séquestre de la table : elles ne gonflent jamais son solde ni sa capacité de couverture avant le règlement.

Un joueur à zéro reçoit automatiquement un premier secours de 100 jetons par jour UTC. Les secours suivants simulent provisoirement une vidéo récompensée : le joueur doit les demander explicitement et le serveur les limite par défaut à trois par jour. Les variables `ALLOW_SIMULATED_REWARDED_GRANT`, `REWARDED_GRANT_DAILY_LIMIT` et `REWARDED_GRANT_COOLDOWN_MS` permettent de désactiver ou resserrer ce mode temporaire. Lors de l'intégration d'une régie publicitaire, remplacer ce mode par la validation serveur du justificatif de vidéo.

## Protections anti-abus

Les contrôles importants sont côté serveur :

- taille maximale de message WebSocket : 16 Kio ;
- `MESSAGE_LIMIT_PER_10S=40` messages par adresse réseau et par compte ;
- `STATE_ACTION_LIMIT_PER_10S=15` actions de jeu par compte ;
- `MAX_CONNECTIONS_PER_IP=5` connexions simultanées par adresse réseau ;
- `REGISTRATION_IP_LIMIT=3` nouveaux comptes par réseau sur 24 heures ;
- `DAILY_ROULETTE_IP_LIMIT=3` roulettes quotidiennes par réseau sur 24 heures ;
- quotas de création et de roulette persistés en SQL, donc non remis à zéro par un redémarrage ;
- aucune adresse IP brute stockée : seul un HMAC non réversible est conservé grâce à `ABUSE_HASH_SECRET` ;
- la liste complète des rooms n'est plus rediffusée après chaque jeton misé.
- un compte ne peut plus multiplier les diffusions en restant présent dans plusieurs rooms.

`ABUSE_HASH_SECRET` est obligatoire avec PostgreSQL. Le Blueprint génère automatiquement un secret de 256 bits. Ne jamais le publier ni le modifier, faute de quoi l'identifiant pseudonymisé d'un même réseau changerait.

Ces valeurs sont volontairement adaptées à un petit cercle de joueurs. Une famille ou une école derrière la même adresse publique partage les quotas ; augmentez-les dans Render si nécessaire.

## Développement local

Sans `DATABASE_URL`, `data/players.json` est utilisé. Les quotas persistants restent alors en mémoire et sont remis à zéro au redémarrage, ce qui est acceptable uniquement en développement.

## Connexion Google et intégrité de l'APK

L'APK utilise le paquet définitif `com.bedealer.game`, un export Gradle et un plugin Android Godot v2 basé sur Credential Manager. L'ID renseigné dans `godot/scripts/google_auth.gd` et la variable Render `GOOGLE_WEB_CLIENT_ID` doivent être exactement le même ID de client OAuth **Web**. Le client OAuth **Android** sert à autoriser le paquet et la clé de signature ; son ID ne doit pas être placé dans ces champs.

Le serveur vérifie la signature, l'audience, l'expiration et le nonce de l'ID token, puis utilise le champ Google `sub` comme identité stable. Aucun secret OAuth Web n'est requis dans l'APK ou sur Render.

Pour rendre les bots sensiblement plus difficiles que par la seule connexion Google, valider aussi un jeton **Google Play Integrity** côté serveur lors de la création du compte et des actions à forte valeur. Google Sign-In empêche l'usurpation d'un compte quand l'ID token est vérifié, mais ne garantit pas à lui seul qu'un humain n'automatise pas plusieurs comptes Google.
