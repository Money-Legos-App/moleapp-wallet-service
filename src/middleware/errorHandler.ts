import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

export const errorHandler = (
  error: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  logger.error('Unhandled error:', {
    error: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
    body: req.body,
    query: req.query,
    params: req.params
  });

  const status = error.status || error.statusCode || 500;
  const message = error.message || 'Internal server error';

  res.status(status).json({
    success: false,
    error: error.code || 'INTERNAL_ERROR',
    message,
    ...(process.env.NODE_ENV !== 'production' && { 
      stack: error.stack,
      details: error.details 
    })
  });
};