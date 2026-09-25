import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { envConfig } from '../config/env.config';
import { ResponseHandler } from '../utils/responseHandler';

export type AdminRole = 'SUPER_ADMIN' | 'FINANCE_ADMIN' | 'GAME_OPERATOR' | 'SUPPORT_ADMIN' | 'VIEWER' | 'ADMIN' | 'GAME_ADMIN';

export type Permission =
  | 'users.read'
  | 'users.manage'
  | 'wallet.read'
  | 'wallet.adjust'
  | 'payments.read'
  | 'payments.approve'
  | 'games.read'
  | 'games.manage'
  | 'reports.read'
  | 'system.manage'
  | 'admins.manage'
  | 'audit.read';

export const ROLE_PERMISSIONS: Record<AdminRole, Permission[]> = {
  SUPER_ADMIN: [
    'users.read',
    'users.manage',
    'wallet.read',
    'wallet.adjust',
    'payments.read',
    'payments.approve',
    'games.read',
    'games.manage',
    'reports.read',
    'system.manage',
    'admins.manage',
    'audit.read'
  ],
  ADMIN: [
    'users.read',
    'users.manage',
    'wallet.read',
    'wallet.adjust',
    'payments.read',
    'payments.approve',
    'games.read',
    'games.manage',
    'reports.read',
    'system.manage',
    'admins.manage',
    'audit.read'
  ],
  GAME_ADMIN: [
    'users.read',
    'users.manage',
    'wallet.read',
    'wallet.adjust',
    'payments.read',
    'payments.approve',
    'games.read',
    'games.manage',
    'reports.read',
    'system.manage',
    'admins.manage',
    'audit.read'
  ],
  FINANCE_ADMIN: [
    'wallet.read',
    'wallet.adjust',
    'payments.read',
    'payments.approve',
    'reports.read',
    'audit.read',
    'users.read'
  ],
  GAME_OPERATOR: [
    'games.read',
    'games.manage',
    'reports.read',
    'system.manage',
    'audit.read',
    'users.read'
  ],
  SUPPORT_ADMIN: [
    'users.read',
    'users.manage',
    'wallet.read',
    'reports.read',
    'audit.read'
  ],
  VIEWER: [
    'users.read',
    'games.read',
    'wallet.read',
    'payments.read',
    'reports.read',
    'audit.read'
  ]
};

export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    const admin = (req as any).admin;
    if (!admin) {
      return ResponseHandler.error(res, 'Unauthorized: Admin authentication required', 401);
    }

    const role = (admin.role || 'VIEWER') as AdminRole;
    const permissions = ROLE_PERMISSIONS[role] || [];

    if (!permissions.includes(permission)) {
      return ResponseHandler.error(
        res,
        `Forbidden: Role ${role} lacks permission ${permission}`,
        403
      );
    }
    return next();
  };
}

export function authenticateAdmin(req: Request, res: Response, next: NextFunction) {
  // 1. Check for Bearer token
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const secret = envConfig.adminJwtSecret || envConfig.jwtSecret;
      const decoded = jwt.verify(token, secret) as any;
      (req as any).admin = {
        id: decoded.id || decoded.userId || 'admin',
        username: decoded.username || 'admin',
        role: decoded.role || 'SUPER_ADMIN'
      };
      return next();
    } catch {
      return ResponseHandler.error(res, 'Unauthorized: Invalid or expired admin token', 401);
    }
  }

  // 2. Check for x-admin-secret header
  const secretHeader = req.headers['x-admin-secret'] as string;
  const configuredSecret = process.env.ADMIN_SECRET_KEY || process.env.ADMIN_PASSWORD || envConfig.adminPassword;
  if (secretHeader && configuredSecret && secretHeader === configuredSecret) {
    (req as any).admin = {
      id: 'sys-admin',
      username: 'sysadmin',
      role: 'SUPER_ADMIN'
    };
    return next();
  }

  return ResponseHandler.error(res, 'Unauthorized: Admin authentication required', 401);
}
