import { Request, Response } from 'express';
import { WalletService } from './wallet.service';
import { ResponseHandler } from '../../utils/responseHandler';

export class WalletController {
  public static getBalance(req: Request, res: Response) {
    const userId = (req as any).user?.userId || req.query.userId || 'DEFAULT_USER';
    const balance = WalletService.getBalance(userId as string);
    return ResponseHandler.success(res, balance, 'Wallet balance fetched');
  }

  public static getTransactions(req: Request, res: Response) {
    const userId = (req as any).user?.userId || req.query.userId || 'DEFAULT_USER';
    const txs = WalletService.getTransactions(userId as string);
    return ResponseHandler.success(res, txs, 'Transactions history fetched');
  }
}
