import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { AuthValidator } from '../../validators/auth.validator';
import { ResponseHandler } from '../../utils/responseHandler';

export class AuthController {
  public static async login(req: Request, res: Response) {
    const validation = AuthValidator.validateLogin(req.body);
    if (!validation.valid) {
      return ResponseHandler.error(res, validation.message || 'Invalid parameters', 400);
    }

    try {
      const { phone, name, deviceModel, osVersion, appVersion, networkType } = req.body;
      const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
      const clientIp = Array.isArray(rawIp) ? rawIp[0] : (typeof rawIp === 'string' ? rawIp.split(',')[0].trim() : '127.0.0.1');

      const result = await AuthService.loginOrRegister(phone, name, {
        deviceModel,
        osVersion,
        appVersion,
        networkType,
        ip: clientIp
      });
      return ResponseHandler.success(res, result, 'Authentication successful');
    } catch (err: any) {
      const isBanned = err.message?.toLowerCase().includes('suspended') || err.message?.toLowerCase().includes('banned');
      return ResponseHandler.error(res, err.message || 'Auth failed', isBanned ? 403 : 401);
    }
  }

  public static async checkStatus(req: Request, res: Response) {
    const userId = (req.query.userId as string) || '';
    const phone = (req.query.phone as string) || '';

    let user = userId ? AuthService.getUserById(userId) : undefined;
    if (!user && phone) {
      user = await AuthService.getUserByPhone(phone);
    }

    if (!user) {
      return ResponseHandler.success(res, { exists: false, isBanned: false }, 'User status checked');
    }

    // Check if caller has verified ownership via JWT
    const authUser = (req as any).user;
    const isOwner = authUser && (authUser.userId === user.id || authUser.id === user.id);

    if (isOwner) {
      return ResponseHandler.success(res, {
        exists: true,
        userId: user.id,
        phone: user.phone,
        name: user.name,
        isBanned: Boolean(user.isBanned)
      }, 'User status retrieved');
    }

    // Public / unauthenticated callers receive minimal existence metadata without PII exposure
    return ResponseHandler.success(res, {
      exists: true,
      isBanned: Boolean(user.isBanned)
    }, 'User status retrieved');
  }

  public static async adminLogin(req: Request, res: Response) {
    const { username, password } = req.body;
    if (!username || !password) {
      return ResponseHandler.error(res, 'Username and password are required', 400);
    }

    try {
      const result = await AuthService.adminLogin(username, password);
      
      const isProduction = process.env.NODE_ENV === 'production';
      res.cookie('adminToken', result.token, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'strict' : 'lax',
        path: '/',
        maxAge: 8 * 60 * 60 * 1000 // 8 hours
      });

      return ResponseHandler.success(res, result, 'Admin login successful');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message || 'Invalid credentials', 401);
    }
  }

  public static async adminLogout(req: Request, res: Response) {
    res.clearCookie('adminToken', { path: '/' });
    return ResponseHandler.success(res, { loggedOut: true }, 'Admin logged out successfully');
  }

  public static async initiateWhatsApp(req: Request, res: Response) {
    const { appKey } = req.body;
    const result = AuthService.initiateWhatsAppAuth(appKey);
    return ResponseHandler.success(res, result, 'WhatsApp OTP-less login initiated');
  }

  public static async verifyWhatsApp(req: Request, res: Response) {
    const { token, phone } = req.body;
    if (!token) {
      return ResponseHandler.error(res, 'token parameter is required', 400);
    }
    try {
      const result = await AuthService.verifyWhatsAppAuth(token, phone);
      if (!result.verified) {
        return ResponseHandler.success(res, { verified: false }, 'Pending WhatsApp verification');
      }
      return ResponseHandler.success(res, result, 'WhatsApp authentication verified successfully');
    } catch (err: any) {
      const status = err.message?.startsWith('INVALID_TOKEN') || err.message?.startsWith('EXPIRED_TOKEN') ? 401 : 400;
      return ResponseHandler.error(res, err.message || 'Verification failed', status);
    }
  }

  public static async getProfile(req: Request, res: Response) {
    const userId = (req as any).user?.userId || (req as any).user?.id;
    if (!userId) {
      return ResponseHandler.error(res, 'Authentication required', 401);
    }
    const user = AuthService.getUserById(userId as string);
    if (!user) {
      return ResponseHandler.error(res, 'User not found', 404);
    }
    return ResponseHandler.success(res, user, 'Profile retrieved');
  }

  public static async updateProfile(req: Request, res: Response) {
    const userId = (req as any).user?.userId || (req as any).user?.id;
    if (!userId) {
      return ResponseHandler.error(res, 'Authentication required', 401);
    }
    try {
      const { name, avatarUrl } = req.body;
      const updatedUser = await AuthService.updateProfile(userId, { name, avatarUrl });
      return ResponseHandler.success(res, updatedUser, 'Profile updated successfully');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message || 'Profile update failed', 400);
    }
  }
}
