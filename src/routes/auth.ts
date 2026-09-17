import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';

export const authRouter = Router();

authRouter.post('/guest', (req: Request, res: Response) => {
  const userId = `USR-${Math.floor(100 + Math.random() * 900)}`;
  const token = jwt.sign({ userId, role: 'player' }, config.jwtSecret, { expiresIn: '7d' });

  res.json({
    success: true,
    data: {
      userId,
      username: 'Satyam Kumar',
      phone: '+91 98765 43210',
      token
    }
  });
});
