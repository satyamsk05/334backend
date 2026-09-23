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

export function authenticateAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.query.secret) {
    return ResponseHandler.error(res, 'Authentication via URL query parameters is forbidden', 400);
  }

  const adminSecret = req.headers['x-admin-secret'];
  const configuredSecret = process.env.ADMIN_SECRET_KEY || envConfig.adminPassword;

  if (configuredSecret && adminSecret && adminSecret === configuredSecret) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, envConfig.adminJwtSecret || envConfig.jwtSecret) as any;
      if (decoded.role === 'ADMIN') {
        (req as any).admin = decoded;
        return next();
      }
    } catch (e) {
      // invalid admin token
    }
  }

  return ResponseHandler.error(res, 'Unauthorized: Admin privileges required', 403);
}
