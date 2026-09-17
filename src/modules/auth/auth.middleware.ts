import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { envConfig } from '../../config/env.config';
import { ResponseHandler } from '../../utils/responseHandler';

export function authenticateJwt(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // If no header, allow dev default user header fallback if present
    const devUserId = req.headers['x-user-id'] as string;
    if (devUserId) {
      (req as any).user = { userId: devUserId };
      return next();
    }
    return ResponseHandler.error(res, 'Authentication token missing', 401);
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, envConfig.jwtSecret);
    (req as any).user = decoded;
    next();
  } catch (err) {
    return ResponseHandler.error(res, 'Invalid or expired token', 401);
  }
}
