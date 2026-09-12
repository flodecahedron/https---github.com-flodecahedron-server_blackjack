import { OAuth2Client } from "google-auth-library";

const clientId = String(process.env.GOOGLE_WEB_CLIENT_ID ?? "").trim();
const oauthClient = clientId ? new OAuth2Client(clientId) : null;

export const isGoogleAuthConfigured = () => oauthClient !== null;

export async function verifyGoogleIdToken(idToken, expectedNonce) {
  if (!oauthClient) throw Error("Connexion Google non configurée sur le serveur");
  const token = String(idToken ?? "").trim();
  if (!token) throw Error("Jeton Google manquant");
  let ticket;
  try {
    ticket = await oauthClient.verifyIdToken({ idToken: token, audience: clientId });
  } catch {
    throw Error("Jeton Google invalide ou expiré");
  }
  const payload = ticket.getPayload();
  if (!payload?.sub) throw Error("Identité Google invalide");
  if (payload.nonce !== expectedNonce) throw Error("Tentative de connexion Google expirée");
  return { sub: payload.sub };
}
