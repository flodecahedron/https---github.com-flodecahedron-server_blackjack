# Blackjack server

Serveur WebSocket autoritaire. Les cartes, mises, actions, soldes et gains ne sont jamais calculés par le client.

Déploiement Render : créez un **Web Service**, root directory `server`, build command `npm install`, start command `npm start`. Configurez `PORT` automatiquement (Render le fournit).

## Persistance des joueurs

Les comptes, soldes et séries de connexion sont sauvegardés après chaque modification. En production, créez une base **Render PostgreSQL** et renseignez sa `DATABASE_URL` dans les variables d'environnement du Web Service ; la table `blackjack_players` est créée automatiquement. Sans cette variable, `data/players.json` est utilisé seulement pour le développement local. PostgreSQL est nécessaire sur Render pour survivre aux redémarrages et redéploiements.
