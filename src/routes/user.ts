import { Router, Request, Response } from 'express';
import { WalletLedger } from '../services/WalletLedger';
import { AuthService } from '../modules/auth/auth.service';
import { DatabaseConfig } from '../config/db.config';

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

userRouter.post('/fcm-token', async (req: Request, res: Response) => {
  const { userId, fcmToken } = req.body;
  if (!userId || !fcmToken) {
    return res.status(400).json({ success: false, message: 'userId and fcmToken are required' });
  }

  const pool = DatabaseConfig.getPool();
  if (pool) {
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT;`);
      await pool.query(`UPDATE users SET fcm_token = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [fcmToken, userId]);
    } catch (e: any) {
      console.warn('Failed to update fcm_token in DB:', e.message);
    }
  }

  res.json({ success: true, message: 'FCM token registered successfully' });
});
