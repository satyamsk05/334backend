import { Router, Request, Response } from 'express';
import { TicTacToeEngine } from '../game/TicTacToeEngine';
import { Logger } from '../utils/logger';

const router = Router();

// 1. Get all stake tiers (₹1, ₹5, ₹10, ₹25, ₹50, ₹100)
router.get('/tiers', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: TicTacToeEngine.getTiers()
  });
});

// 2. Get active room for user
router.get('/room', (req: Request, res: Response) => {
  const userId = (req.query.userId as string) || (req.headers['x-user-id'] as string) || '';
  if (!userId) {
    return res.status(400).json({ success: false, message: 'userId is required' });
  }
  const room = TicTacToeEngine.getRoomForUser(userId);
  return res.json({
    success: true,
    data: room || null
  });
});

// 3. Join Matchmaking Queue
router.post('/join', async (req: Request, res: Response) => {
  try {
    const { userId, name, avatarUrl, tierId } = req.body;

    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      return res.status(400).json({ success: false, message: 'Valid userId is required' });
    }

    if (!tierId) {
      return res.status(400).json({ success: false, message: 'tierId is required' });
    }

    const result = await TicTacToeEngine.joinQueue(userId, name || 'Player', avatarUrl || '', tierId);
    if (!result.success) {
      return res.status(400).json(result);
    }

    return res.json(result);
  } catch (err: any) {
    Logger.error('[XO-API] Join Queue Error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 4. Submit Move
router.post('/move', async (req: Request, res: Response) => {
  try {
    const { userId, roomId, cellIndex } = req.body;

    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ success: false, message: 'userId is required' });
    }

    if (!roomId || cellIndex === undefined) {
      return res.status(400).json({ success: false, message: 'roomId and cellIndex required' });
    }

    const result = await TicTacToeEngine.makeMove(userId, roomId, Number(cellIndex));
    if (!result.success) {
      return res.status(400).json(result);
    }

    return res.json(result);
  } catch (err: any) {
    Logger.error('[XO-API] Make Move Error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

export default router;
