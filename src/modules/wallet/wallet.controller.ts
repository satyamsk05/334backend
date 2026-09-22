import { Request, Response } from 'express';
import { WalletService } from './wallet.service';
import { ResponseHandler } from '../../utils/responseHandler';

export class WalletController {
  public static getBalance(req: Request, res: Response) {
    const authenticatedUserId = (req as any).user?.userId;
    if (!authenticatedUserId) {
      return ResponseHandler.error(res, 'Unauthorized: Valid user token required', 401);
    }
    const balance = WalletService.getBalance(authenticatedUserId);
    return ResponseHandler.success(res, balance, 'Wallet balance fetched');
  }

  public static getTransactions(req: Request, res: Response) {
    const authenticatedUserId = (req as any).user?.userId;
    if (!authenticatedUserId) {
      return ResponseHandler.error(res, 'Unauthorized: Valid user token required', 401);
    }
    const txs = WalletService.getTransactions(authenticatedUserId);
    return ResponseHandler.success(res, txs, 'Transactions history fetched');
  }
}
