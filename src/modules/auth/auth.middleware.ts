import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { envConfig } from '../../config/env.config';
import { ResponseHandler } from '../../utils/responseHandler';

export function authenticateJwt(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return ResponseHandler.error(res, 'Authentication token missing', 401);
  }

  const token = authHeader.slice('Bearer '.length).trim();

  if (!token) {
    return ResponseHandler.error(res, 'Authentication token missing', 401);
  }

  try {
    const decoded = jwt.verify(token, envConfig.jwtSecret);
    (req as any).user = decoded;
    return next();
  } catch (err) {
    return ResponseHandler.error(res, 'Invalid or expired token', 401);
  }
}

export function optionalAuthenticateJwt(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim();
    if (token) {
      try {
        const decoded = jwt.verify(token, envConfig.jwtSecret);
        (req as any).user = decoded;
      } catch (err) {
        // ignore invalid token for optional auth
      }
    }
  }
  return next();
}

export { authenticateAdmin } from '../../middleware/rbac.middleware';

