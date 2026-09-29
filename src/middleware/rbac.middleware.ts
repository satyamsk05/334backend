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
    'payments.read',
    'games.read',
    'games.manage',
    'reports.read',
    'audit.read'
  ],
  GAME_ADMIN: [
    'games.read',
    'games.manage',
    'reports.read',
    'users.read',
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

export async function resolveAuthoritativeAdmin(decoded: any): Promise<{ id: string; username: string; role: AdminRole } | null> {
  const adminId = decoded?.id || decoded?.userId;
  const username = decoded?.username;

  if (!username) return null;

  // 1. Authoritative PostgreSQL verification (overrides any role claimed in JWT)
  try {
    const { DatabaseConfig } = await import('../config/db.config');
    const pool = DatabaseConfig.getPool();
    if (pool) {
      const res = await pool.query(
        'SELECT id, username, role, is_active FROM admins WHERE id = $1 OR username = $2 LIMIT 1',
        [adminId, username]
      );
      if (res.rows.length > 0) {
        const row = res.rows[0];
        if (!row.is_active) {
          return null; // Disabled admin account
        }
        return {
          id: row.id,
          username: row.username,
          role: row.role as AdminRole
        };
      }
    }
  } catch (err) {
    // If DB is temporarily unavailable or check fails, do not allow arbitrary escalation
  }

  // 2. Fallback to master environment admin (exact match required)
  if (
    adminId === 'env-super-admin' &&
    envConfig.adminUsername &&
    username === envConfig.adminUsername
  ) {
    return {
      id: 'env-super-admin',
      username,
      role: 'SUPER_ADMIN'
    };
  }

  return null;
}

function extractCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

export async function authenticateAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.query?.secret) {
    return ResponseHandler.error(res, 'Authentication via URL query parameters is forbidden', 400);
  }

  let token: string | null = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.headers.cookie) {
    token = extractCookie(req.headers.cookie, 'adminToken');
  }

  if (!token) {
    return ResponseHandler.error(res, 'Unauthorized: Admin authentication required', 401);
  }

  try {
    const secret = envConfig.adminJwtSecret || envConfig.jwtSecret;
    const decoded = jwt.verify(token, secret) as any;

    const adminPrincipal = await resolveAuthoritativeAdmin(decoded);
    if (!adminPrincipal) {
      return ResponseHandler.error(res, 'Unauthorized: Admin account is invalid or inactive', 403);
    }

    (req as any).admin = adminPrincipal;
    return next();
  } catch {
    return ResponseHandler.error(res, 'Unauthorized: Invalid or expired admin token', 401);
  }
}
