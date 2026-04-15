import axios from 'axios';
import { logger } from '../../utils/logger';
import env from '../../config/environment';

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getServiceToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 30_000) {
    return tokenCache.token;
  }
  const tokenUrl = `${env.keycloakUrl}/realms/${env.keycloakRealm}/protocol/openid-connect/token`;
  const response = await axios.post(tokenUrl, new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.keycloakClientId,
    client_secret: env.keycloakClientSecret,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 });
  const { access_token, expires_in } = response.data;
  tokenCache = { token: access_token, expiresAt: Date.now() + expires_in * 1000 };
  return access_token;
}

export async function sendTransactionNotification(
  userId: string,
  payload: { title: string; message: string; type: string; data?: Record<string, any> },
): Promise<void> {
  try {
    const token = await getServiceToken();
    await axios.post(
      `${env.notificationServiceUrl}/api/v1/notifications/internal`,
      { userId, title: payload.title, message: payload.message, type: payload.type, data: payload.data, sendPush: true },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, timeout: 5000 },
    );
    logger.info('Transaction notification sent', { userId, title: payload.title });
  } catch (error) {
    logger.warn('Failed to send transaction notification', {
      userId, title: payload.title,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
