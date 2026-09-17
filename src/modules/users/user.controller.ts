import { Request, Response } from 'express';
import { UserService } from './user.service';
import { ResponseHandler } from '../../utils/responseHandler';

export class UserController {
  public static getOverview(req: Request, res: Response) {
    const userId = (req as any).user?.userId || req.query.userId || 'DEFAULT_USER';
    const data = UserService.getUserOverview(userId as string);
    return ResponseHandler.success(res, data, 'User overview retrieved');
  }

  public static listAll(req: Request, res: Response) {
    const users = UserService.getAllUsers();
    return ResponseHandler.success(res, users, 'Users list retrieved');
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

  public static adjustWallet(req: Request, res: Response) {
    const { userId, type, amountRupees } = req.body;
    if (!userId || !type || !amountRupees) {
      return ResponseHandler.error(res, 'userId, type, and amountRupees are required', 400);
    }
    const result = UserService.adjustWallet(userId, type, amountRupees);
    return ResponseHandler.success(res, result, 'Wallet adjusted successfully');
  }
}
