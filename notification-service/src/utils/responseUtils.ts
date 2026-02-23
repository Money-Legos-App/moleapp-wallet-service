import { Response } from 'express';
import { logger } from './logger';

/**
 * Standardized response utility class
 * Implements consistent API response formats across all endpoints
 */
export class ResponseUtils {
  /**
   * Send success response
   */
  static success(res: Response, data: any, message?: string, statusCode: number = 200) {
    const response = {
      status: 'success',
      ...(message && { message }),
      data
    };

    return res.status(statusCode).json(response);
  }

  /**
   * Send error response
   */
  static error(res: Response, message: string, statusCode: number = 500, details?: any) {
    const response = {
      status: 'error',
      message,
      ...(details && { details }),
      timestamp: new Date().toISOString()
    };

    // Log error for debugging
    logger.error('API Error Response', {
      statusCode,
      message,
      details,
      timestamp: response.timestamp
    });

    return res.status(statusCode).json(response);
  }

  /**
   * Send authentication success response
   */
  static authSuccess(res: Response, data: any, message: string = 'Authentication successful') {
    return this.success(res, data, message, 200);
  }

  /**
   * Send authentication error response
   */
  static authError(res: Response, message: string = 'Authentication failed', statusCode: number = 401) {
    return this.error(res, message, statusCode);
  }

  /**
   * Send validation error response
   */
  static validationError(res: Response, errors: any[], message: string = 'Validation failed') {
    return this.error(res, message, 400, { validationErrors: errors });
  }

  /**
   * Send not found response
   */
  static notFound(res: Response, resource: string = 'Resource') {
    return this.error(res, `${resource} not found`, 404);
  }

  /**
   * Send created response
   */
  static created(res: Response, data: any, message: string = 'Resource created successfully') {
    return this.success(res, data, message, 201);
  }

  /**
   * Send updated response
   */
  static updated(res: Response, data: any, message: string = 'Resource updated successfully') {
    return this.success(res, data, message, 200);
  }

  /**
   * Send deleted response
   */
  static deleted(res: Response, message: string = 'Resource deleted successfully') {
    return this.success(res, null, message, 200);
  }

  /**
   * Send registration success response
   */
  static registrationSuccess(res: Response, data: any) {
    return this.created(res, data, 'Registration initiated successfully');
  }

  /**
   * Send login success response
   */
  static loginSuccess(res: Response, data: any) {
    return this.success(res, data, 'Login initiated successfully');
  }

  /**
   * Send OTP verification success response
   */
  static otpVerificationSuccess(res: Response, data: any) {
    return this.success(res, data, 'OTP verified successfully');
  }

  /**
   * Send token validation success response
   */
  static tokenValidationSuccess(res: Response, data: any) {
    return this.success(res, data, 'Token validation successful');
  }

  /**
   * Send OTP resend success response
   */
  static otpResendSuccess(res: Response, data: any) {
    return this.success(res, data, 'OTP resent successfully');
  }

  /**
   * Send token refresh success response
   */
  static tokenRefreshSuccess(res: Response, data: any) {
    return this.success(res, data, 'Token refreshed successfully');
  }

  /**
   * Send logout success response
   */
  static logoutSuccess(res: Response) {
    return this.success(res, null, 'Logout successful');
  }

  /**
   * Send PIN operation success response
   */
  static pinSuccess(res: Response, data: any, operation: string = 'PIN operation') {
    return this.success(res, data, `${operation} completed successfully`);
  }

  /**
   * Send service error response
   */
  static serviceError(res: Response, service: string, message?: string) {
    const defaultMessage = `${service} service temporarily unavailable`;
    return this.error(res, message || defaultMessage, 503);
  }

  /**
   * Send rate limit error response
   */
  static rateLimitError(res: Response, message: string = 'Rate limit exceeded') {
    return this.error(res, message, 429);
  }

  /**
   * Send maintenance mode response
   */
  static maintenanceMode(res: Response, message: string = 'Service under maintenance') {
    return this.error(res, message, 503);
  }

  /**
   * Send forbidden response
   */
  static forbidden(res: Response, message: string = 'Access forbidden') {
    return this.error(res, message, 403);
  }

  /**
   * Send unauthorized response
   */
  static unauthorized(res: Response, message: string = 'Unauthorized access') {
    return this.error(res, message, 401);
  }

  /**
   * Send bad request response
   */
  static badRequest(res: Response, message: string = 'Bad request') {
    return this.error(res, message, 400);
  }

  /**
   * Send conflict response
   */
  static conflict(res: Response, message: string = 'Resource conflict') {
    return this.error(res, message, 409);
  }

  /**
   * Send internal server error response
   */
  static internalServerError(res: Response, message: string = 'Internal server error') {
    return this.error(res, message, 500);
  }

  /**
   * Handle and format validation errors from express-validator
   */
  static handleValidationErrors(validationErrors: any[]): any[] {
    return validationErrors.map(error => ({
      field: error.param,
      message: error.msg,
      value: error.value
    }));
  }

  /**
   * Send app error response (for AppError instances)
   */
  static appErrorResponse(res: Response, error: any) {
    const statusCode = error.statusCode || 500;
    const message = error.message || 'Internal server error';
    const code = error.code || 'INTERNAL_ERROR';
    
    return this.error(res, message, statusCode, { code });
  }
}

// Named function exports for compatibility with existing momo-service code
export const successResponse = (res: Response, data: any, message?: string, statusCode: number = 200) => {
  return ResponseUtils.success(res, data, message, statusCode);
};

export const errorResponse = (res: Response, message: string, details?: any, statusCode: number = 500) => {
  return ResponseUtils.error(res, message, statusCode, details);
};

export const validationErrorResponse = (res: Response, validationErrors: any[]) => {
  return ResponseUtils.validationError(res, validationErrors);
}; 