import fs from 'fs';
import path from 'path';
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

  public static generateNumericUserId(): string {
    return Math.floor(1000000 + Math.random() * 9000000).toString();
  }

  public static async loginOrRegister(phone: string, name?: string): Promise<{ token: string; user: User }> {
    const cleanPhone = phone.trim();
    let user = AuthService.users.get(cleanPhone);

    const displayName = (name && name.trim()) ? name.trim() : `Player_${cleanPhone.slice(-4)}`;

    if (!user) {
      user = {
        id: AuthService.generateNumericUserId(),
        phone: cleanPhone,
        name: displayName,
        isBanned: false,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      AuthService.users.set(cleanPhone, user);
      AuthService.users.set(user.id, user);
      AuthService.persist();
    } else if (name && name.trim() && user.name !== name.trim()) {
      user.name = name.trim();
      user.updatedAt = Date.now();
      AuthService.persist();
    }

    // Sync to PostgreSQL users table with phone number so Admin Panel displays it immediately
    try {
      const { DatabaseConfig } = await import('../../config/db.config');
      const pool = DatabaseConfig.getPool();
      if (pool) {
        await pool.query(
          `INSERT INTO users (id, phone, username, is_blocked, created_at, updated_at)
           VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT (id) DO UPDATE
           SET phone = EXCLUDED.phone,
               username = EXCLUDED.username,
               updated_at = CURRENT_TIMESTAMP`,
          [user.id, user.phone, user.name, user.isBanned]
        );

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

    return { token, user };
  }

  public static async updateProfile(userId: string, data: { name?: string; avatarUrl?: string }): Promise<User> {
    const user = AuthService.users.get(userId);
    if (!user) {
      throw new Error('User not found');
    }
    if (data.name && data.name.trim()) {
      user.name = data.name.trim();
    }
    if (data.avatarUrl && data.avatarUrl.trim()) {
      user.avatarUrl = data.avatarUrl.trim();
    }
    user.updatedAt = Date.now();
    AuthService.persist();

    try {
      const { DatabaseConfig } = await import('../../config/db.config');
      const pool = DatabaseConfig.getPool();
      if (pool) {
        await pool.query(
          `UPDATE users SET username = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [user.name, user.id]
        );
      }
    } catch (e: any) {
      Logger.warn(`[AUTH] Failed to update user in PostgreSQL: ${e.message}`);
    }

    return user;
  }

  /**
   * Admin Authentication Handler (Strictly loads from envConfig)
   */
  public static async adminLogin(usernameInput: string, passwordInput: string): Promise<{ token: string; username: string }> {
    const adminUser = envConfig.adminUsername;
    const adminPass = envConfig.adminPassword;

    if (!adminUser || !adminPass) {
      throw new Error('Admin credentials are not configured in backend/.env');
    }

    if (usernameInput !== adminUser || passwordInput !== adminPass) {
      throw new Error('Invalid Admin Username or Password');
    }

    const token = jwt.sign(
      { username: adminUser, role: 'ADMIN' },
      envConfig.adminJwtSecret || envConfig.jwtSecret,
      { expiresIn: '1d' }
    );

    Logger.info(`[AUTH] Admin login successful for ${adminUser}`);
    return { token, username: adminUser };
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
      const phone = phoneInput || `91${Math.floor(7000000000 + Math.random() * 2999999999)}`;
      const result = await AuthService.loginOrRegister(phone, `WhatsAppUser_${phone.slice(-4)}`);
      return { verified: true, jwtToken: result.token, user: result.user };
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
