import { Request, Response, NextFunction } from 'express';
import { validationResult } from 'express-validator';
import { logger } from '../utils/logger.js';

export const validateRequest = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    const errorMessages = errors.array().map(error => ({
      field: error.type === 'field' ? error.path : 'unknown',
      message: error.msg,
      value: error.type === 'field' ? error.value : undefined
    }));

    logger.warn('Request validation failed:', {
      path: req.path,
      method: req.method,
      errors: errorMessages
    });

    return res.status(400).json({
      success: false,
      error: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: errorMessages
    });
  }

  next();
};