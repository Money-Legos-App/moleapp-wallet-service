import axios, { AxiosInstance } from 'axios';

export interface KeycloakConfig {
  baseURL: string;
  realm: string;
  clientId: string;
  clientSecret: string;
}

export interface ServiceToken {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export interface TokenValidationResult {
  active: boolean;
  sub?: string;
  username?: string;
  email?: string;
  client_id?: string;
  // AA Binding claims from Keycloak Protocol Mappers
  turnkey_sub_org_id?: string;
  wallet_config_address?: string;
  phone_number?: string;
}

export interface KeycloakAuthService {
  getServiceToken(): Promise<ServiceToken>;
  validateToken(token: string): Promise<TokenValidationResult>;
  getHttpClient(): AxiosInstance;
}

export function createKeycloakAuth(config: KeycloakConfig): KeycloakAuthService {
  let cachedToken: ServiceToken | null = null;
  let tokenExpiryTime: number = 0;

  const httpClient = axios.create({
    baseURL: config.baseURL,
    timeout: 10000,
  });

  const getServiceToken = async (): Promise<ServiceToken> => {
    const now = Date.now();

    // Return cached token if still valid (with 30 second buffer)
    if (cachedToken && tokenExpiryTime > now + 30000) {
      return cachedToken;
    }

    const tokenUrl = `${config.baseURL}/realms/${config.realm}/protocol/openid-connect/token`;

    const response = await axios.post(tokenUrl, new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const tokenData: ServiceToken = response.data;
    cachedToken = tokenData;
    tokenExpiryTime = now + (tokenData.expires_in * 1000);

    return tokenData;
  };

  /**
   * Validate token - ONLY via Keycloak introspection
   *
   * SECURITY: No custom JWT validation, no HS256 fallback.
   * All tokens MUST be issued and validated by Keycloak.
   */
  const validateToken = async (token: string): Promise<TokenValidationResult> => {
    const cleanToken = token.replace('Bearer ', '');

    try {
      const introspectUrl = `${config.baseURL}/realms/${config.realm}/protocol/openid-connect/token/introspect`;

      const response = await axios.post(introspectUrl, new URLSearchParams({
        token: cleanToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 5000,
      });

      // Extract AA binding claims from introspection response
      const data = response.data;
      return {
        active: data.active,
        sub: data.sub,
        username: data.username || data.preferred_username,
        email: data.email,
        client_id: data.client_id,
        // AA Binding claims from Protocol Mappers
        turnkey_sub_org_id: data.turnkey_sub_org_id,
        wallet_config_address: data.wallet_config_address,
        phone_number: data.phone_number,
      };
    } catch (introspectError) {
      // Keycloak introspection failed
      return { active: false };
    }
  };

  const getHttpClient = (): AxiosInstance => {
    return httpClient;
  };

  return {
    getServiceToken,
    validateToken,
    getHttpClient,
  };
}