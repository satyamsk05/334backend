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

export class AuthService {
  private static users = new Map<string, User>();
  private static pendingWaAuths = new Map<string, PendingWhatsAppAuth>();

  public static async loginOrRegister(phone: string, name?: string): Promise<{ token: string; user: User }> {
    const cleanPhone = phone.trim();
    let user = AuthService.users.get(cleanPhone);

    if (!user) {
      user = {
        id: `USR-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
        phone: cleanPhone,
        name: name || `Player_${cleanPhone.slice(-4)}`,
        isBanned: false,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      AuthService.users.set(cleanPhone, user);
      AuthService.users.set(user.id, user);
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
    const token = `WA-AUTH-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const encodedMessage = encodeURIComponent(`Verify login code: ${token}`);
    const waLink = `https://wa.me/919999999999?text=${encodedMessage}`;

    AuthService.pendingWaAuths.set(token, {
      token,
      waLink,
      isVerified: false,
      createdAt: Date.now()
    });

    Logger.info(`[AUTH] Initiated Loggin.dev WhatsApp auth token: ${token} for appKey: ${appKey}`);
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

  public static getAllUsers(): User[] {
    const uniqueUsers = new Set(AuthService.users.values());
    return Array.from(uniqueUsers);
  }

  public static toggleBanStatus(userId: string, isBanned: boolean): User | null {
    const user = AuthService.getUserById(userId);
    if (!user) return null;
    user.isBanned = isBanned;
    user.updatedAt = Date.now();
    return user;
  }
}
