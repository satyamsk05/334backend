import { Request, Response } from 'express';
import { WalletService } from './wallet.service';
import { ResponseHandler } from '../../utils/responseHandler';

export class WalletController {
  public static getBalance(req: Request, res: Response) {
    const rawUserId = (req as any).user?.userId || (req as any).user?.id || (req.query.userId as string);
    if (!rawUserId || typeof rawUserId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(rawUserId)) {
      return ResponseHandler.error(res, 'Valid userId is required', 400);
    }
    const userId = rawUserId;
    const balance = WalletService.getBalance(userId);
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
  }

  public static getTransactions(req: Request, res: Response) {
    const rawUserId = (req as any).user?.userId || (req as any).user?.id || (req.query.userId as string);
    if (!rawUserId || typeof rawUserId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(rawUserId)) {
      return ResponseHandler.error(res, 'Valid userId is required', 400);
    }
    const userId = rawUserId;
    const txs = WalletService.getTransactions(userId);
    return ResponseHandler.success(res, txs, 'Transactions history fetched');
  }
}
