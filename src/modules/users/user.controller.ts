import { Request, Response } from 'express';
import { UserService } from './user.service';
import { ResponseHandler } from '../../utils/responseHandler';

export class UserController {
  public static async getOverview(req: Request, res: Response) {
    const userId = (req as any).user?.userId || req.query.userId || 'DEFAULT_USER';
    try {
      const data = await UserService.getUserOverview(userId as string);
      return ResponseHandler.success(res, data, 'User overview retrieved');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message || 'Failed to retrieve user overview', 500);
    }
  }

  public static async listAll(req: Request, res: Response) {
    try {
      const users = await UserService.getAllUsers();
      return ResponseHandler.success(res, users, 'Users list retrieved');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message || 'Failed to list users', 500);
    }
  }

  public static toggleBan(req: Request, res: Response) {
    const { userId, isBanned } = req.body;
    if (!userId) {
      return ResponseHandler.error(res, 'userId is required', 400);
    }
    const updated = UserService.toggleBan(userId, Boolean(isBanned));
    if (!updated) {
      return ResponseHandler.error(res, 'User not found', 404);
    }
    return ResponseHandler.success(res, updated, `User ${isBanned ? 'banned' : 'unbanned'} successfully`);
  }

  public static async registerFcmToken(req: Request, res: Response) {
    const userId = (req as any).user?.userId || (req as any).user?.id;
    const { fcmToken } = req.body;

    if (!userId) {
      return ResponseHandler.error(res, 'Authentication required', 401);
    }
    if (!fcmToken) {
      return ResponseHandler.error(res, 'fcmToken is required', 400);
    }

    const pool = (await import('../../config/db.config')).DatabaseConfig.getPool();
    if (pool) {
      try {
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT;`);
        await pool.query(`UPDATE users SET fcm_token = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [fcmToken, userId]);
      } catch (e: any) {
        console.warn('Failed to update fcm_token in DB:', e.message);
      }
    }

    return ResponseHandler.success(res, { userId, fcmToken }, 'FCM token registered successfully');
  }
}
