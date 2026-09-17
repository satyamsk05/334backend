import { Router, Request, Response } from 'express';
import { WalletLedger } from '../services/WalletLedger';

export const userRouter = Router();

userRouter.get('/profile', (req: Request, res: Response) => {
  const userId = (req.query.userId as string) || 'USR-304';
  const balance = WalletLedger.getUserBalance(userId);

  res.json({
    success: true,
    data: {
      userId,
      username: 'Satyam Kumar',
      phone: '+91 98765 43210',
      balance
    }
  });
});
