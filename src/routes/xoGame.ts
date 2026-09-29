import { Router, Request, Response } from 'express';
import { TicTacToeEngine } from '../game/TicTacToeEngine';
import { Logger } from '../utils/logger';
import { authenticateJwt } from '../modules/auth/auth.middleware';

const router = Router();

function getAuthenticatedUserId(req: Request): string {
  const user = (req as any).user;
  return user?.userId || user?.id || '';
}

// 1. Get all stake tiers (₹1, ₹5, ₹10, ₹25, ₹50, ₹100) - Public catalog
router.get('/tiers', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: TicTacToeEngine.getTiers()
  });
});

// 2. Get active room for user - Requires authenticated session
router.get('/room', authenticateJwt, async (req: Request, res: Response) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  const room = await TicTacToeEngine.getRoomForUserAsync(userId);
  return res.json({
    success: true,
    data: room || null
  });
});

// 3. Join Matchmaking Queue - Requires authenticated session
router.post('/join', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { name, avatarUrl, tierId } = req.body;

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
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

// 4. Submit Move - Requires authenticated session
router.post('/move', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { roomId, cellIndex } = req.body;

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
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

// 5. End Game / Settle Outcome - Server Authoritative Settlement
router.post('/end', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { roomId, tierId } = req.body;

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    if (!roomId) {
      return res.status(400).json({ success: false, message: 'roomId is required' });
    }

    const settleRes = await TicTacToeEngine.settleGameResult(userId, roomId, tierId);
    if (!settleRes.success) {
      return res.status(400).json(settleRes);
    }

    return res.json(settleRes);
  } catch (err: any) {
    Logger.error('[XO-API] Settle End Game Error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

export default router;

