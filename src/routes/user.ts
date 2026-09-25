import { Router, Request, Response } from 'express';
import { WalletLedger } from '../services/WalletLedger';
import { AuthService } from '../modules/auth/auth.service';

export const userRouter = Router();

userRouter.get('/profile', async (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  if (!userId || !userId.trim()) {
    return res.status(400).json({ success: false, message: 'userId query parameter is required' });
  }

  const user = AuthService.getUserById(userId);
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  const balance = await WalletLedger.getUserBalance(userId);

  res.json({
    success: true,
    data: {
      userId: user.id,
      username: user.name,
      phone: user.phone,
      balance
    }
  });
});
