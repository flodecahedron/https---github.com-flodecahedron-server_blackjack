# Blackjack server

Serveur WebSocket autoritaire. Les cartes, mises, actions, soldes et gains ne sont jamais calculés par le client.

Déploiement Render : créez un **Web Service**, root directory `server`, build command `npm install`, start command `npm start`. Configurez `PORT` automatiquement (Render le fournit). Pour la production, remplacez les `Map` mémoire par PostgreSQL/Redis : une instance Render redémarrée ne doit pas conserver comptes et parties.
