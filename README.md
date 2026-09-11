# Serveur Casino Royale

Serveur WebSocket autoritaire pour le blackjack et la roulette américaine multijoueur. Les cartes, tirages, mises, actions, soldes et gains ne sont jamais calculés par le client.

## Déploiement Render recommandé

Le fichier `render.yaml` à la racine du dépôt serveur décrit le Web Service et PostgreSQL. Dans Render :

1. Ouvrir **New > Blueprint** et sélectionner le dépôt Git.
2. Vérifier que le Blueprint détecté est `render.yaml`, puis créer les ressources.
3. Attendre que la base soit disponible et que le Web Service affiche `Live`.
4. Ouvrir `https://<nom-du-service>.onrender.com/health`. La réponse doit contenir `"persistence":"postgres"`.
5. Copier l'adresse du service sous la forme `wss://<nom-du-service>.onrender.com` dans `DEFAULT_URL` du fichier local `godot/scripts/network.gd`, puis reconstruire l'APK.

Ne définissez pas `PORT` : Render l'injecte. Le service utilise `npm ci`, `npm start`, le dossier racine `server` et `/health` comme health check.

### Attention à PostgreSQL gratuit

Un Web Service gratuit convient au faible trafic du jeu. En revanche, une base Render PostgreSQL gratuite expire après 30 jours et ne possède pas de sauvegardes. Pour ne jamais perdre les progressions, passer uniquement la base sur un plan persistant payant, ou utiliser un PostgreSQL externe persistant. Le serveur accepte l'un ou l'autre via `DATABASE_URL`.

## Migrer les comptes de l'ancienne base

Installer les outils PostgreSQL (`pg_dump` et `pg_restore`), puis utiliser temporairement les URL **externes** des deux bases. Ne jamais ajouter ces URL au dépôt.

```powershell
$env:OLD_DB_URL = "postgresql://...ancienne-base..."
$env:NEW_DB_URL = "postgresql://...nouvelle-base..."
pg_dump --format=custom --no-owner --no-acl --dbname=$env:OLD_DB_URL --file=casino-royale.backup
pg_restore --clean --if-exists --no-owner --no-acl --dbname=$env:NEW_DB_URL casino-royale.backup
```

Le Blueprint bloque l'accès PostgreSQL externe (`ipAllowList: []`). Pour effectuer la migration, autoriser temporairement uniquement votre adresse IP dans **Postgres > Networking**, puis remettre la liste vide. Le Web Service doit utiliser l'URL **interne** injectée automatiquement dans `DATABASE_URL`.

Sans migration, les tables `blackjack_players` et `blackjack_abuse_events` sont créées automatiquement au premier démarrage.

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

La connexion Google n'est pas une simple modification GDScript. Le client Android actuel utilise encore le nom de paquet provisoire `com.example.$genname` et l'export Gradle est désactivé. Une intégration propre nécessite :

1. choisir un nom de paquet Android définitif et ne plus le changer ;
2. enregistrer ce paquet et les empreintes SHA-1/SHA-256 des clés de signature dans Google Auth Platform ;
3. créer les identifiants OAuth Android et Web ;
4. installer le template Android Godot et activer **Use Gradle Build** ;
5. intégrer Credential Manager dans un plugin Android Godot v2 ;
6. envoyer l'ID token Google au serveur et le vérifier côté Node avant de retrouver le compte SQL ;
7. offrir une action de liaison aux anciens profils afin de conserver leur solde ;
8. après migration, refuser la création anonyme de comptes en production.

Pour rendre les bots sensiblement plus difficiles que par la seule connexion Google, valider aussi un jeton **Google Play Integrity** côté serveur lors de la création du compte et des actions à forte valeur. Google Sign-In empêche l'usurpation d'un compte quand l'ID token est vérifié, mais ne garantit pas à lui seul qu'un humain n'automatise pas plusieurs comptes Google.
