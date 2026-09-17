import { Request, Response, NextFunction } from 'express';
import { Logger } from './logger';
import { ResponseHandler } from './responseHandler';

interface AppError extends Error {
  status?: number;
  statusCode?: number;
  code?: string;
  isOperational?: boolean;
}

function getStatusCode(error: AppError): number {
  const status = error.statusCode ?? error.status ?? 500;
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

export function errorHandler(
  err: AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): Response {
  const statusCode = getStatusCode(err);
  const isProduction = process.env.NODE_ENV === 'production';

  Logger.error(`Unhandled Error on ${req.method} ${req.originalUrl}:`, err);

  // Never expose stack traces, database errors, tokens, or internal details in production.
  const message = isProduction && statusCode >= 500
    ? 'Internal Server Error'
    : (err.isOperational || statusCode < 500)
      ? err.message || 'Request failed'
      : 'Internal Server Error';

  const errors = !isProduction && statusCode >= 500
    ? { code: err.code, stack: err.stack }
    : null;

  return ResponseHandler.error(res, message, statusCode, errors);
}
