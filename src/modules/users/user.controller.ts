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

  public static async adjustWallet(req: Request, res: Response) {
    const { userId, type, amountRupees } = req.body;
    if (!userId || !type || !amountRupees) {
      return ResponseHandler.error(res, 'userId, type, and amountRupees are required', 400);
    }
    try {
      const result = await UserService.adjustWallet(userId, type, amountRupees);
      return ResponseHandler.success(res, result, 'Wallet adjusted successfully');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message || 'Failed to adjust wallet', 500);
    }
  }
}
