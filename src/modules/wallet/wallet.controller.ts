import { Request, Response } from 'express';
import { WalletService } from './wallet.service';
import { ResponseHandler } from '../../utils/responseHandler';

export class WalletController {
  public static async getBalance(req: Request, res: Response) {
    const userId = (req as any).user?.userId || (req as any).user?.id;
    if (!userId || typeof userId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(userId)) {
      return ResponseHandler.error(res, 'Unauthorized or invalid user identity', 401);
    }
    try {
      const balance = await WalletService.getBalance(userId);
      return ResponseHandler.success(res, {
        userId,
        depositPaise: balance.depositPaise,
        winningPaise: balance.winningPaise,
        bonusPaise: balance.bonusPaise,
        totalPaise: balance.totalPaise,
        depositRupees: balance.depositPaise / 100,
        winningRupees: balance.winningPaise / 100,
        bonusRupees: balance.bonusPaise / 100,
        totalRupees: balance.totalPaise / 100
      }, 'Wallet balance fetched');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message || 'Failed to fetch balance', 500);
    }
  }

  public static async getTransactions(req: Request, res: Response) {
    const userId = (req as any).user?.userId || (req as any).user?.id;
    if (!userId || typeof userId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(userId)) {
      return ResponseHandler.error(res, 'Unauthorized or invalid user identity', 401);
    }
    try {
      const txs = await WalletService.getTransactions(userId);
      return ResponseHandler.success(res, txs, 'Transactions history fetched');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message || 'Failed to fetch transactions', 500);
    }
  }
}
