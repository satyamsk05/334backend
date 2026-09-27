import { Router, Request, Response } from 'express';
import { TicTacToeEngine } from '../game/TicTacToeEngine';
import { Logger } from '../utils/logger';
import { optionalAuthenticateJwt } from '../modules/auth/auth.middleware';

const router = Router();

function resolveXoUserId(req: Request): string {
  const user = (req as any).user;
  if (user?.userId || user?.id) return user.userId || user.id;
  return (req.body?.userId as string) || (req.query?.userId as string) || (req.headers['x-user-id'] as string) || '';
}

// 1. Get all stake tiers (₹1, ₹5, ₹10, ₹25, ₹50, ₹100)
router.get('/tiers', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: TicTacToeEngine.getTiers()
  });
});

// 2. Get active room for user
router.get('/room', optionalAuthenticateJwt, (req: Request, res: Response) => {
  const userId = resolveXoUserId(req);
  if (!userId) {
    return res.status(400).json({ success: false, message: 'Valid userId or authentication is required' });
  }
  const room = TicTacToeEngine.getRoomForUser(userId);
  return res.json({
    success: true,
    data: room || null
  });
});

// 3. Join Matchmaking Queue
router.post('/join', optionalAuthenticateJwt, async (req: Request, res: Response) => {
  try {
    const userId = resolveXoUserId(req);
    const { name, avatarUrl, tierId } = req.body;

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
router.post('/move', optionalAuthenticateJwt, async (req: Request, res: Response) => {
  try {
    const userId = resolveXoUserId(req);
    const { roomId, cellIndex } = req.body;

    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ success: false, message: 'Valid userId is required' });
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
