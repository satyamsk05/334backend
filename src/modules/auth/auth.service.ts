import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { envConfig } from '../../config/env.config';
import { User } from '../../database/models/User';
import { Logger } from '../../utils/logger';

interface PendingWhatsAppAuth {
  token: string;
  waLink: string;
  phone?: string;
  isVerified: boolean;
  createdAt: number;
}

const USERS_FILE = path.join(__dirname, '../../../data/users_ledger.json');

function loadUsers(): User[] {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
      if (Array.isArray(data)) return data;
    }
  } catch (e) {
    console.error('Failed to load users from disk:', e);
  }
  return [];
}

const initialUsers = loadUsers();

export class AuthService {
  private static users = new Map<string, User>(
    initialUsers.flatMap(u => [
      [u.id, u],
      ...(u.phone ? [[u.phone, u] as [string, User]] : [])
    ])
  );
  private static pendingWaAuths = new Map<string, PendingWhatsAppAuth>();

  private static persist() {
    try {
      const dir = path.dirname(USERS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const unique = Array.from(new Set(AuthService.users.values()));
      fs.writeFileSync(USERS_FILE, JSON.stringify(unique, null, 2), 'utf-8');
    } catch (e) {
      console.error('Failed to persist users:', e);
    }
  }

  public static normalizePhone(phone: string): string {
    if (!phone) return '';
    const cleaned = phone.replace(/[^0-9]/g, '');
    // If 10 digits (Indian standard without CC), prepend 91 for consistency
    if (cleaned.length === 10) {
      return `91${cleaned}`;
    }
    return cleaned;
  }

  public static generateNumericUserId(): string {
    return Math.floor(1000000 + Math.random() * 9000000).toString();
  }

  public static async getUserByPhone(phone: string): Promise<User | undefined> {
    const cleanPhone = AuthService.normalizePhone(phone);
    if (!cleanPhone) return undefined;

    // 1. Check in-memory map first (check both 91 prefix and 10 digit variant)
    const tenDigit = cleanPhone.startsWith('91') && cleanPhone.length === 12 ? cleanPhone.slice(2) : cleanPhone;
    let user = AuthService.users.get(cleanPhone) || AuthService.users.get(tenDigit);
    if (user) return user;

    // 2. Query PostgreSQL users table
    try {
      const { DatabaseConfig } = await import('../../config/db.config');
      const pool = DatabaseConfig.getPool();
      if (pool) {
        const queryRes = await pool.query(
          `SELECT id, username, phone, is_blocked, avatar_path, 
                  EXTRACT(EPOCH FROM created_at)*1000 as created_at_ms,
                  EXTRACT(EPOCH FROM updated_at)*1000 as updated_at_ms
           FROM users 
           WHERE phone = $1 OR phone = $2 OR phone = $3 OR phone = $4
           LIMIT 1`,
          [cleanPhone, tenDigit, `+${cleanPhone}`, `+${tenDigit}`]
        );

        if (queryRes.rows.length > 0) {
          const row = queryRes.rows[0];
          user = {
            id: row.id,
            phone: cleanPhone,
            name: row.username || `Player_${cleanPhone.slice(-4)}`,
            avatarUrl: row.avatar_path,
            isBanned: Boolean(row.is_blocked),
            createdAt: Number(row.created_at_ms || Date.now()),
            updatedAt: Number(row.updated_at_ms || Date.now())
          };
          // Cache in memory
          AuthService.users.set(user.id, user);
          AuthService.users.set(cleanPhone, user);
          AuthService.users.set(tenDigit, user);
          AuthService.persist();
          return user;
        }
      }
    } catch (dbErr: any) {
      Logger.warn(`[AUTH] DB phone lookup error: ${dbErr.message}`);
    }

    return undefined;
  }

  public static async loginOrRegister(
    phone: string, 
    name?: string,
    deviceInfo?: {
      deviceModel?: string;
      osVersion?: string;
      appVersion?: string;
      networkType?: string;
      ip?: string;
      location?: string;
    }
  ): Promise<{ token: string; user: User; isNewUser: boolean }> {
    const cleanPhone = AuthService.normalizePhone(phone);
    const tenDigit = cleanPhone.startsWith('91') && cleanPhone.length === 12 ? cleanPhone.slice(2) : cleanPhone;
    
    // Look up existing user across database and memory by phone
    let user = await AuthService.getUserByPhone(cleanPhone);
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      const displayName = (name && name.trim()) ? name.trim() : `Player_${cleanPhone.slice(-4)}`;
      user = {
        id: AuthService.generateNumericUserId(),
        phone: cleanPhone,
        name: displayName,
        isBanned: false,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      AuthService.users.set(cleanPhone, user);
      AuthService.users.set(tenDigit, user);
      AuthService.users.set(user.id, user);
      AuthService.persist();
    } else {
      isNewUser = false;
      // If a new valid custom name is provided, update it
      if (name && name.trim() && user.name !== name.trim() && !name.trim().startsWith('Player_') && !name.trim().startsWith('WhatsAppUser_')) {
        user.name = name.trim();
        user.updatedAt = Date.now();
        AuthService.persist();
      }
    }

    // Sync to PostgreSQL users table with phone number and device telemetry
    try {
      const { DatabaseConfig } = await import('../../config/db.config');
      const pool = DatabaseConfig.getPool();
      if (pool) {
        await pool.query(
          `INSERT INTO users (
             id, phone, username, is_blocked, last_sign_in_at, 
             device_model, os_version, app_version, ip_address, location,
             created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT (id) DO UPDATE
           SET phone = EXCLUDED.phone,
               username = EXCLUDED.username,
               last_sign_in_at = CURRENT_TIMESTAMP,
               device_model = COALESCE(EXCLUDED.device_model, users.device_model),
               os_version = COALESCE(EXCLUDED.os_version, users.os_version),
               app_version = COALESCE(EXCLUDED.app_version, users.app_version),
               ip_address = COALESCE(EXCLUDED.ip_address, users.ip_address),
               location = COALESCE(EXCLUDED.location, users.location),
               updated_at = CURRENT_TIMESTAMP`,
          [
            user.id, 
            user.phone, 
            user.name, 
            user.isBanned,
            deviceInfo?.deviceModel || null,
            deviceInfo?.osVersion || null,
            deviceInfo?.appVersion || null,
            deviceInfo?.ip || null,
            deviceInfo?.location || (deviceInfo?.networkType ? `${deviceInfo.networkType} Network` : 'India')
          ]
        );

        // Record audit session
        try {
          const sessionId = `sess_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`;
          await pool.query(
            `INSERT INTO user_sessions (
               id, user_id, device_model, os_version, app_version, ip_address, network_type, location, created_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)`,
            [
              sessionId,
              user.id,
              deviceInfo?.deviceModel || 'Android Device',
              deviceInfo?.osVersion || 'Android',
              deviceInfo?.appVersion || '1.0.0',
              deviceInfo?.ip || '127.0.0.1',
              deviceInfo?.networkType || 'Mobile',
              deviceInfo?.location || 'India'
            ]
          );
        } catch (sessErr: any) {
          Logger.warn(`[AUTH] Non-fatal user_sessions audit record issue: ${sessErr.message}`);
        }

        // Also ensure wallet exists
        await pool.query(
          `INSERT INTO wallets (
             id, user_id, available_balance, deposit_balance, winnings_balance,
             rewards_balance, reserved_balance, locked_balance, version,
             created_at, updated_at
           )
           VALUES ($1, $2, 0, 0, 0, 0, 0, 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT (user_id) DO NOTHING`,
          [`wlt_${user.id}`, user.id]
        );
      }
    } catch (dbErr: any) {
      Logger.warn(`[AUTH] Failed to sync user to PostgreSQL pool: ${dbErr.message}`);
    }

    if (user.isBanned) {
      throw new Error('User account has been suspended by administration.');
    }

    const token = jwt.sign(
      { userId: user.id, phone: user.phone, name: user.name, role: 'PLAYER' },
      envConfig.jwtSecret,
      { expiresIn: '30d' }
    );

    return { token, user, isNewUser };
  }

  public static async updateProfile(userId: string, data: { name?: string; phone?: string; avatarUrl?: string }): Promise<User> {
    let user = AuthService.users.get(userId);
    if (!user) {
      user = AuthService.ensureUserExists(userId, data.name, data.phone);
    }
    if (data.name && data.name.trim()) {
      user.name = data.name.trim();
    }
    if (data.phone && data.phone.trim()) {
      user.phone = AuthService.normalizePhone(data.phone.trim());
    }
    if (data.avatarUrl && data.avatarUrl.trim()) {
      user.avatarUrl = data.avatarUrl.trim();
    }
    user.updatedAt = Date.now();
    AuthService.users.set(user.id, user);
    if (user.phone) {
      AuthService.users.set(user.phone, user);
    }
    AuthService.persist();

    try {
      const { DatabaseConfig } = await import('../../config/db.config');
      const pool = DatabaseConfig.getPool();
      if (pool) {
        await pool.query(
          `UPDATE users 
           SET username = COALESCE($1, username), 
               phone = COALESCE($2, phone),
               avatar_path = COALESCE($3, avatar_path),
               updated_at = CURRENT_TIMESTAMP 
           WHERE id = $4`,
          [data.name?.trim() || null, user.phone || null, data.avatarUrl?.trim() || null, user.id]
        );
      }
    } catch (e: any) {
      Logger.warn(`[AUTH] Failed to update user in PostgreSQL: ${e.message}`);
    }

    return user;
  }

  /**
   * Admin Authentication Handler (Checks PostgreSQL admins table first, fallbacks to envConfig)
   */
  public static async adminLogin(usernameInput: string, passwordInput: string): Promise<{ token: string; username: string; role?: string }> {
    const cleanUsername = usernameInput?.trim();
    const cleanPassword = passwordInput?.trim();

    if (!cleanUsername || !cleanPassword) {
      throw new Error('Username and password are required');
    }

    // 1. Try PostgreSQL admins table
    try {
      const { DatabaseConfig } = await import('../../config/db.config');
      const pool = DatabaseConfig.getPool();
      if (pool) {
        const queryRes = await pool.query(
          `SELECT id, username, password_hash, role, is_active FROM admins WHERE username = $1 LIMIT 1`,
          [cleanUsername]
        );
        if (queryRes.rows.length > 0) {
          const adminRow = queryRes.rows[0];
          if (!adminRow.is_active) {
            throw new Error('Admin account is disabled');
          }

          let isPasswordValid = false;
          const storedHash = adminRow.password_hash || '';

          if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$')) {
            isPasswordValid = await bcrypt.compare(cleanPassword, storedHash);
          } else if (process.env.NODE_ENV === 'production') {
            Logger.error(`[AUTH] Non-bcrypt password hash detected for admin ${adminRow.username} in production. Login rejected.`);
            throw new Error('Invalid Admin Username or Password');
          } else {
            // Upgrade legacy SHA-256 hash to bcrypt; reject plaintext (dev only)
            const sha256Pass = crypto.createHash('sha256').update(cleanPassword).digest('hex');
            if (storedHash.length === sha256Pass.length && crypto.timingSafeEqual(Buffer.from(storedHash), Buffer.from(sha256Pass))) {
              isPasswordValid = true;
              const upgradedBcrypt = await bcrypt.hash(cleanPassword, 10);
              await pool.query('UPDATE admins SET password_hash = $1 WHERE id = $2', [upgradedBcrypt, adminRow.id]);
            }
          }

          if (isPasswordValid) {
            await pool.query('UPDATE admins SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1', [adminRow.id]);
            const token = jwt.sign(
              { id: adminRow.id, username: adminRow.username, role: adminRow.role || 'ADMIN' },
              envConfig.adminJwtSecret || (process.env.NODE_ENV !== 'production' ? envConfig.jwtSecret : ''),
              { expiresIn: '1d' }
            );
            Logger.info(`[AUTH] Admin login successful for DB admin: ${adminRow.username} (Role: ${adminRow.role})`);
            return { token, username: adminRow.username, role: adminRow.role };
          }
        }
      }
    } catch (err: any) {
      if (err.message === 'Admin account is disabled') throw err;
      Logger.warn(`[AUTH] DB admin check error, checking env credentials: ${err.message}`);
    }

    // 2. Fallback to envConfig credentials
    const adminUser = envConfig.adminUsername;
    const adminPass = envConfig.adminPassword;

    if (adminUser && adminPass && cleanUsername === adminUser) {
      let isEnvPassValid = false;
      if (adminPass.startsWith('$2a$') || adminPass.startsWith('$2b$')) {
        isEnvPassValid = await bcrypt.compare(cleanPassword, adminPass);
      } else if (process.env.NODE_ENV === 'production') {
        Logger.error('[AUTH] ADMIN_PASSWORD must be a bcrypt hash in production.');
        isEnvPassValid = false;
      } else {
        const passBuf = crypto.createHash('sha256').update(cleanPassword).digest();
        const expectedBuf = crypto.createHash('sha256').update(adminPass).digest();
        isEnvPassValid = crypto.timingSafeEqual(passBuf, expectedBuf);
      }

      if (isEnvPassValid) {
        const token = jwt.sign(
          { id: 'env-super-admin', username: adminUser, role: 'SUPER_ADMIN' },
          envConfig.adminJwtSecret || envConfig.jwtSecret,
          { expiresIn: '1d' }
        );
        Logger.info(`[AUTH] Admin login successful for master admin: ${adminUser}`);
        return { token, username: adminUser, role: 'SUPER_ADMIN' };
      }
    }

    throw new Error('Invalid Admin Username or Password');
  }

  /**
   * Loggin.dev WhatsApp OTP-less initiation
   */
  public static initiateWhatsAppAuth(appKeyOverride?: string): { token: string; waLink: string } {
    const appKey = appKeyOverride || envConfig.logginAppKey;
    if (!appKey) {
      throw new Error('LOGGIN_APP_KEY is not configured in backend .env');
    }
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let rand = '';
    for (let i = 0; i < 6; i++) rand += chars[Math.floor(Math.random() * chars.length)];
    const token = `${appKey}-${rand}`;
    const msg = `Please do not edit this message.\nLOGGIN ${token}`;
    const waLink = `https://wa.me/919989907408?text=${encodeURIComponent(msg)}`;

    AuthService.pendingWaAuths.set(token, {
      token,
      waLink,
      isVerified: false,
      createdAt: Date.now()
    });

    Logger.info(`[AUTH] Initiated Loggin.dev WhatsApp auth token: ${token}`);
    return { token, waLink };
  }

  /**
   * Loggin.dev WhatsApp token verification callback or polling check
   */
  public static async verifyWhatsAppAuth(token: string, phoneInput?: string): Promise<{ verified: boolean; jwtToken?: string; user?: User }> {
    const auth = AuthService.pendingWaAuths.get(token);
    if (!auth) {
      throw new Error('INVALID_TOKEN: Unknown or invalid WhatsApp verification token');
    }

    const WA_AUTH_EXPIRY_MS = 10 * 60 * 1000;
    if (Date.now() - auth.createdAt > WA_AUTH_EXPIRY_MS) {
      AuthService.pendingWaAuths.delete(token);
      throw new Error('EXPIRED_TOKEN: WhatsApp verification token has expired');
    }

    if (phoneInput) {
      auth.phone = phoneInput;
      auth.isVerified = true;
    }

    if (auth.isVerified && auth.phone) {
      const result = await AuthService.loginOrRegister(auth.phone, `WhatsAppUser_${auth.phone.slice(-4)}`);
      AuthService.pendingWaAuths.delete(token);
      return { verified: true, jwtToken: result.token, user: result.user };
    }

    return { verified: false };
  }

  public static getUserById(userId: string): User | undefined {
    return AuthService.users.get(userId);
  }

  public static ensureUserExists(userId: string, name?: string, phone?: string): User {
    let user = AuthService.users.get(userId);
    if (!user) {
      user = {
        id: userId,
        phone: phone || '',
        name: name || (userId.startsWith('USR-') ? `Player_${userId.slice(-4)}` : userId),
        isBanned: false,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      AuthService.users.set(userId, user);
      if (phone) {
        AuthService.users.set(phone, user);
      }
      AuthService.persist();
    }

    // Ensure PostgreSQL user record exists synchronously/idempotently so foreign keys referencing users(id) succeed
    (async () => {
      try {
        const { DatabaseConfig } = await import('../../config/db.config');
        const pool = DatabaseConfig.getPool();
        if (pool) {
          try {
            await pool.query(
              `INSERT INTO users (id, username, phone, created_at, updated_at)
               VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
               ON CONFLICT (id) DO UPDATE
               SET phone = COALESCE(EXCLUDED.phone, users.phone),
                   username = CASE WHEN users.username LIKE 'Player_%' AND EXCLUDED.username NOT LIKE 'Player_%' THEN EXCLUDED.username ELSE users.username END,
                   updated_at = CURRENT_TIMESTAMP`,
              [user.id, user.name, user.phone || null]
            );
          } catch (phoneConflictErr: any) {
            if (phoneConflictErr?.code === '23505' && phoneConflictErr?.constraint === 'users_phone_key') {
              // Phone already owned by another user; persist with null phone so foreign keys referencing users(id) are satisfied
              await pool.query(
                `INSERT INTO users (id, username, phone, created_at, updated_at)
                 VALUES ($1, $2, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                 ON CONFLICT (id) DO UPDATE
                 SET username = CASE WHEN users.username LIKE 'Player_%' AND EXCLUDED.username NOT LIKE 'Player_%' THEN EXCLUDED.username ELSE users.username END,
                     updated_at = CURRENT_TIMESTAMP`,
                [user.id, user.name]
              );
            } else {
              throw phoneConflictErr;
            }
          }
        }
      } catch (err: any) {
        console.error('ensureUserExists PG error:', err.message);
      }
    })();

    return user;
  }

  public static getAllUsers(): User[] {
    const uniqueUsers = new Set(AuthService.users.values());
    return Array.from(uniqueUsers);
  }

  public static toggleBanStatus(userId: string, isBanned: boolean): User | null {
    const user = AuthService.getUserById(userId);
    if (!user) return null;
    user.isBanned = isBanned;
    user.updatedAt = Date.now();
    AuthService.persist();
    return user;
  }
}
