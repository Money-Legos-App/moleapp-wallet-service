import { Request, Response, NextFunction } from 'express';
import { env } from '../config/environment.js';
import { logger } from '../utils/logger.js';
import { createKeycloakAuth } from "../utils/keycloakAuth"
import { ResponseUtils } from "../utils/responseUtils"

export interface AuthenticatedRequest extends Request {
  userId?: string;
  userEmail?: string;
  organizationId?: string;
  auth?: {
    clientId: string;
    username?: string;
    subject: string;
    scopes: string[];
    expires: number;
  };
}

// Initialize Keycloak authentication service
const keycloakAuth = createKeycloakAuth({
  baseURL: env.keycloakUrl,
  realm: env.keycloakRealm,
  clientId: env.keycloakClientId,
  clientSecret: env.keycloakClientSecret,
});

logger.info('Keycloak auth config', {
  baseURL: env.keycloakUrl,
  realm: env.keycloakRealm,
  clientId: env.keycloakClientId,
  hasSecret: !!env.keycloakClientSecret,
});

// Create authentication middleware
export const authenticate = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return ResponseUtils.unauthorized(res, 'Missing or invalid authorization header');
    }

    const token = authHeader.substring(7);
    const tokenValidation = await keycloakAuth.validateToken(token);

    logger.info('Token introspection result', {
      active: tokenValidation.active,
      sub: tokenValidation.sub ?? '(undefined)',
      subType: typeof tokenValidation.sub,
      email: tokenValidation.email ?? '(undefined)',
      clientId: tokenValidation.client_id ?? '(undefined)',
      username: tokenValidation.username ?? '(undefined)',
      path: req.path,
      method: req.method,
    });

    if (!tokenValidation.active) {
      return ResponseUtils.unauthorized(res, 'Invalid or expired token');
    }

    req.userId = tokenValidation.sub;
    req.userEmail = tokenValidation.email;
    req.auth = {
      clientId: tokenValidation.client_id || '',
      username: tokenValidation.username,
      subject: tokenValidation.sub || '',
      scopes: [],
      expires: Date.now() + 3600000 // 1 hour default
    };

    next();
  } catch (error) {
    logger.error('Authentication failed', { error: error instanceof Error ? error.message : String(error) });
    return ResponseUtils.internalServerError(res, 'Authentication service error');
  }
};

// Legacy middleware for backward compatibility - extracts userId from token subject
export const authenticateWithUserId = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  // First run Keycloak authentication
  authenticate(req, res, () => {
    try {
      // Extract userId from token subject or username for backward compatibility
      if (req.auth?.subject) {
        req.userId = req.auth.subject;
      } else if (req.auth?.username) {
        req.userId = req.auth.username;
      }

      logger.debug(`Authenticated service request`, {
        clientId: req.auth?.clientId,
        userId: req.userId,
        scopes: req.auth?.scopes
      });
      
      next();
    } catch (error: any) {
      logger.error('User ID extraction failed:', error);
      return ResponseUtils.error(res, 'Authentication processing error', 500, {
        code: 'AUTH_ERROR'
      });
    }
  });
};