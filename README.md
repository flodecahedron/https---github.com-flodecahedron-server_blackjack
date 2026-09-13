# Serveur BeDealer

Serveur WebSocket autoritaire pour le blackjack et la roulette américaine multijoueur. Les cartes, tirages, mises, actions, soldes et gains ne sont jamais calculés par le client.

## Structure interne

- `index.js` assemble les services, authentifie les connexions et orchestre leur cycle de vie ;
- `realtime-transport.js` sérialise les messages et gère snapshots, versions et deltas par client ;
- `room-actions.js` route les commandes vers la bonne mécanique sans mélanger blackjack et roulette ;
- `game-room.js` et `roulette-room.js` restent les modèles autoritaires des parties ;
- `player-store.js` concentre la persistance Neon et son mode fichier de développement.

Cette séparation doit être conservée : les scènes Godot animent et présentent les états reçus, mais aucune décision économique ou aléatoire ne doit leur être transférée.

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
- une room envoie un snapshot à l'entrée, puis uniquement des opérations différentielles versionnées ;
- le classement SQL ne renvoie que le top 3, le rang du joueur ou une page de 25 profils ;
- la liste complète des comptes n'est jamais envoyée à un client.

`ABUSE_HASH_SECRET` est obligatoire avec PostgreSQL. Le Blueprint génère automatiquement un secret de 256 bits. Ne jamais le publier ni le modifier, faute de quoi l'identifiant pseudonymisé d'un même réseau changerait.

Ces valeurs sont volontairement adaptées à un petit cercle de joueurs. Une famille ou une école derrière la même adresse publique partage les quotas ; augmentez-les dans Render si nécessaire.

## Suivi de la bande passante

`TRAFFIC_METRICS_INTERVAL_SECONDS=300` produit toutes les cinq minutes une ligne Render préfixée par `[traffic]`. Elle contient les octets et le nombre de messages entrants/sortants, ventilés par type (`room_snapshot`, `room_delta`, `leaderboard_page`, etc.). Les compteurs sont agrégés en mémoire puis remis à zéro après chaque rapport ; aucune donnée joueur n'est journalisée.

`LOG_WS_MESSAGES=false` désactive en production la ligne de log de chaque message WebSocket. Les connexions, erreurs, alertes de sécurité et rapports de trafic restent visibles. Réactiver temporairement cette variable uniquement pour diagnostiquer un problème précis.

Le protocole réseau courant est la version 2. Il ne maintient volontairement pas la compatibilité des anciens APK : publier le nouvel APK en même temps que ce serveur. Le client anime les cartes et les jetons localement à partir des changements de données ; le serveur reste autoritaire sur les cartes, mises, résultats et soldes.

## Développement local

Sans `DATABASE_URL`, `data/players.json` est utilisé. Les quotas persistants restent alors en mémoire et sont remis à zéro au redémarrage, ce qui est acceptable uniquement en développement.

## Connexion Google et intégrité de l'APK

L'APK utilise le paquet définitif `com.bedealer.game`, un export Gradle et un plugin Android Godot v2 basé sur Credential Manager. L'ID renseigné dans `godot/scripts/google_auth.gd` et la variable Render `GOOGLE_WEB_CLIENT_ID` doivent être exactement le même ID de client OAuth **Web**. Le client OAuth **Android** sert à autoriser le paquet et la clé de signature ; son ID ne doit pas être placé dans ces champs.

Le serveur vérifie la signature, l'audience, l'expiration et le nonce de l'ID token, puis utilise le champ Google `sub` comme identité stable. Aucun secret OAuth Web n'est requis dans l'APK ou sur Render.

Les sessions applicatives sont hachées en base, expirent après 90 jours et sont renouvelées à chaque restauration réussie. L'ancien jeton reste valable cinq minutes uniquement pour absorber une réponse perdue pendant la rotation. Une déconnexion révoque immédiatement la session. La suppression de compte efface le profil, le journal financier et la liaison Google par cascade SQL. L'adresse e-mail Google n'est ni utilisée ni stockée ; la migration vide les anciennes valeurs tout en conservant temporairement la colonne vide pour permettre un rollback Render sûr.

## Rapports de crash

Avec l'option client « Envoyer les rapports de crash » activée, un diagnostic limité est transmis après le redémarrage qui suit un arrêt anormal. Le serveur n'accepte que trois rapports par compte et par période de 24 heures, vingt par réseau, et 12 Kio au maximum par rapport. Les e-mails, jetons Bearer et structures de JWT sont supprimés côté client avant l'envoi, puis filtrés une seconde fois côté serveur. Les rapports expirent automatiquement après 30 jours et sont supprimés avec le compte joueur.

Les diagnostics sont stockés dans `bedealer_crash_reports`. Ils contiennent la version de l'application, Android, le modèle, la scène, une trace technique limitée et les quarante dernières lignes du journal interne. Ils ne contiennent ni solde, ni adresse e-mail, ni jeton Google, ni jeton de session.

Pour consulter les derniers rapports dans Neon :

```sql
SELECT report_id, kind, app_version, version_code, platform, os_version,
       device_model, scene, diagnostics, occurred_at, received_at
FROM bedealer_crash_reports
ORDER BY received_at DESC
LIMIT 50;
```

Le serveur de production utilise Node.js 24, fixé par `package.json`, `.node-version` et `NODE_VERSION` dans le Blueprint Render. Les durées sont configurables avec `SESSION_TTL_DAYS` et `SESSION_ROTATION_GRACE_MINUTES`.

Pour rendre les bots sensiblement plus difficiles que par la seule connexion Google, valider aussi un jeton **Google Play Integrity** côté serveur lors de la création du compte et des actions à forte valeur. Google Sign-In empêche l'usurpation d'un compte quand l'ID token est vérifié, mais ne garantit pas à lui seul qu'un humain n'automatise pas plusieurs comptes Google.

## Google Play Integrity

Le plugin Android prépare un fournisseur de jetons Play Integrity standard et répond au défi envoyé après chaque authentification. Le serveur transmet le jeton chiffré à Google, puis contrôle le `requestHash`, l'âge de la requête, le paquet `com.bedealer.game`, `PLAY_RECOGNIZED`, `MEETS_DEVICE_INTEGRITY` et, en production Play, `LICENSED`. Une attestation acceptée reste valable 30 minutes sur la connexion WebSocket courante.

Configuration nécessaire :

1. Dans la Play Console, créer l'application `com.bedealer.game`, lier le projet Google Cloud `92573100008` et activer Play Integrity API.
2. Créer un compte de service dans ce même projet, lui donner l'accès nécessaire à Play Integrity, puis placer la totalité de sa clé JSON dans le secret Render `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.
3. Déployer d'abord avec `PLAY_INTEGRITY_MODE=audit`. Les verdicts apparaissent dans les logs sous `[integrity]` mais ne bloquent personne.
4. Distribuer une version par une piste de test Google Play et vérifier des verdicts `verified` sur plusieurs téléphones.
5. Passer ensuite `PLAY_INTEGRITY_MODE=enforce`. Les actions de jeu qui modifient l'état sont alors refusées aux clients non attestés, tandis que quitter une table, se déconnecter et supprimer son compte restent toujours possibles.

Ne jamais activer `enforce` avant la distribution par Google Play : une APK installée directement est normalement `UNLICENSED` ou `UNRECOGNIZED_VERSION`. La clé du compte de service ne doit jamais être incluse dans l'APK ou le dépôt Git.
