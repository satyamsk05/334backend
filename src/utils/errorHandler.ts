import { Request, Response, NextFunction } from 'express';
import { Logger } from './logger';
import { ResponseHandler } from './responseHandler';

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  Logger.error(`Unhandled Error on ${req.method} ${req.url}:`, err);
  return ResponseHandler.error(res, err.message || 'Internal Server Error', err.status || 500);
}
