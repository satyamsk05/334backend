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
      const { phone, name } = req.body;
      const result = await AuthService.loginOrRegister(phone, name);
      return ResponseHandler.success(res, result, 'Authentication successful');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message || 'Auth failed', 401);
    }
  }

  public static async adminLogin(req: Request, res: Response) {
    const { username, password } = req.body;
    if (!username || !password) {
      return ResponseHandler.error(res, 'Username and password are required', 400);
    }

    try {
      const result = await AuthService.adminLogin(username, password);
      return ResponseHandler.success(res, result, 'Admin login successful');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message || 'Invalid credentials', 401);
    }
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
      return ResponseHandler.error(res, err.message || 'Verification failed', 400);
    }
  }

  public static async getProfile(req: Request, res: Response) {
    const userId = (req as any).user?.userId || req.query.userId || 'DEFAULT_USER';
    const user = AuthService.getUserById(userId as string);
    if (!user) {
      return ResponseHandler.error(res, 'User not found', 404);
    }
    return ResponseHandler.success(res, user, 'Profile retrieved');
  }
}
