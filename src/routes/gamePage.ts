import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { RingOfFutureEngine, MultiplierType } from '../game/RingOfFutureEngine';
import { WalletLedger } from '../services/WalletLedger';
import { envConfig } from '../config/env.config';
import { authenticateJwt, optionalAuthenticateJwt } from '../modules/auth/auth.middleware';
import { PageAccessTicket } from '../services/PageAccessTicket';

export const gamePageRouter = Router();

function resolveUserIdFromRequest(req: Request): string {
  const user = (req as any).user;
  if (user?.userId || user?.id) return user.userId || user.id;

  const authHeader = req.headers.authorization;
  const token = (authHeader && authHeader.startsWith('Bearer '))
    ? authHeader.slice(7).trim()
    : (req.query.token as string) || (req.body?.token as string);

  if (token) {
    try {
      const decoded: any = jwt.verify(token, envConfig.jwtSecret);
      return decoded.userId || decoded.id || '';
    } catch {
      // Invalid token
    }
  }

  return '';
}

function mintShortLivedPageJwt(userId: string): string {
  return jwt.sign(
    { userId, purpose: 'game-page' },
    envConfig.jwtSecret,
    { expiresIn: '15m' }
  );
}

gamePageRouter.get('/api/v1/ring-of-future/state', optionalAuthenticateJwt, async (req: Request, res: Response) => {
  const userId = resolveUserIdFromRequest(req);
  const state = RingOfFutureEngine.getSnapshotForUser(userId);
  const wallet = userId ? await WalletLedger.getUserBalance(userId) : { depositPaise: 0, winningPaise: 0, bonusPaise: 0, totalPaise: 0 };
  res.json({ success: true, data: { gameState: state, wallet } });
});

gamePageRouter.post('/api/v1/ring-of-future/bet', authenticateJwt, async (req: Request, res: Response) => {
  const authenticatedUserId = (req as any).user?.userId || (req as any).user?.id;
  if (!authenticatedUserId || typeof authenticatedUserId !== 'string' || !authenticatedUserId.trim()) {
    return res.status(401).json({ success: false, message: 'Authentication required to place bets' });
  }

  // If request body explicitly specifies a userId, it must match the verified token principal
  const requestedUserId = req.body?.userId;
  if (requestedUserId && requestedUserId !== authenticatedUserId) {
    return res.status(403).json({ success: false, message: 'Forbidden: You cannot place bets on behalf of another user' });
  }

  const userId = authenticatedUserId;
  const { multiplierType, amountRupees } = req.body;
  const num = parseFloat(amountRupees);
  if (isNaN(num) || num <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid bet amount' });
  }

  const amountPaise = Math.round(num * 100);
  const result = await RingOfFutureEngine.placeBet(userId, multiplierType as MultiplierType, amountPaise);

  if (!result.success) {
    return res.status(400).json(result);
  }

  const state = RingOfFutureEngine.getSnapshotForUser(userId);
  const wallet = await WalletLedger.getUserBalance(userId);

  res.json({
    success: true,
    message: result.message,
    data: { gameState: state, wallet }
  });
});

gamePageRouter.get('/game/ring-of-future', async (req: Request, res: Response) => {
  const ticketParam = typeof req.query.ticket === 'string' ? req.query.ticket : '';
  const ticketPayload = await PageAccessTicket.resolve(ticketParam, 'game');

  let userId = ticketPayload?.userId || '';
  let sessionJwt = '';

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    sessionJwt = authHeader.slice(7).trim();
    try {
      const decoded: any = jwt.verify(sessionJwt, envConfig.jwtSecret);
      userId = decoded.userId || decoded.id || userId;
    } catch {
      sessionJwt = '';
    }
  }

  if (!userId || !/^[a-zA-Z0-9_-]+$/.test(userId)) {
    return res.status(401).send('<div style="padding: 20px; font-family: sans-serif; text-align: center; color: red;"><h3>Error: Authentication required to access Ring of Future.</h3></div>');
  }

  // Embed a short-lived page JWT for in-page fetch calls — never the long-lived session JWT from the URL
  const pageJwt = mintShortLivedPageJwt(userId);
  // Opaque ticket for deposit deep-links from this page
  const payTicket = await PageAccessTicket.issue(userId, 'pay', { amountRupees: 500 });

  const wallet = await WalletLedger.getUserBalance(userId);
  const initialState = RingOfFutureEngine.getSnapshotForUser(userId);

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>Ring of Future - 334Game</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Outfit', sans-serif; user-select: none; }
    body { background: #2A2A2A; color: #FFFFFF; min-height: 100vh; display: flex; justify-content: center; align-items: center; overflow: hidden; }
    .game-container { width: 100%; max-width: 440px; height: 100vh; max-height: 920px; background: #2F2F2F; display: flex; flex-direction: column; justify-content: space-between; padding: 16px; position: relative; }
    
    /* Top Header */
    .top-header { display: flex; justify-content: space-between; align-items: center; height: 48px; }
    .btn-back { display: flex; align-items: center; gap: 6px; font-size: 16px; font-weight: 700; color: #FFFFFF; background: transparent; border: none; cursor: pointer; }
    
    /* Native App Style Wallet Chip (Matching WalletChip.kt & Screenshot 2) */
    .wallet-chip-container { position: relative; display: inline-flex; align-items: center; height: 38px; cursor: pointer; }
    .wallet-chip-container:active { transform: scale(0.96); }
    .wallet-pill-bg {
      height: 36px;
      margin-left: 12px;
      padding-left: 30px;
      padding-right: 14px;
      background: #1B2230;
      border: 1px solid #2F394C;
      border-radius: 9999px;
      box-shadow: 0 4px 10px rgba(0, 0, 0, 0.45);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .wallet-amount-text {
      font-family: 'Rubik', sans-serif;
      font-size: 16px;
      font-weight: 700;
      color: #FFFFFF;
      letter-spacing: 0.3px;
      line-height: 1;
      white-space: nowrap;
    }
    .wallet-coin-icon {
      position: absolute;
      left: 0;
      top: 0;
      width: 38px;
      height: 38px;
      border-radius: 50%;
      background: radial-gradient(circle at 35% 35%, #FFE082, #FFB800 60%, #B45309 100%);
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      line-height: 1;
      border: 1.5px solid #FEF08A;
      pointer-events: none;
    }

    /* Canvas Stage Area */
    .canvas-stage { width: 100%; position: relative; display: flex; justify-content: center; align-items: center; margin: 10px 0; }
    canvas { display: block; max-width: 100%; will-change: transform; transform: translate3d(0, 0, 0); backface-visibility: hidden; }
    .wheel-arrow { position: absolute; top: -2px; left: 50%; transform: translateX(-50%); width: 0; height: 0; border-left: 9px solid transparent; border-right: 9px solid transparent; border-top: 15px solid #FFFFFF; z-index: 10; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.6)); pointer-events: none; }

    /* Center Overlay Badge */
    .center-overlay { position: absolute; background: #3A3D3E; border: 2px solid #525658; border-radius: 12px; padding: 8px 18px; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.4); pointer-events: none; }
    .center-overlay .timer-val { font-size: 18px; font-weight: 900; color: #10B981; }
    .center-overlay .phase-label { font-size: 11px; font-weight: 700; color: #D1D5DB; letter-spacing: 0.5px; text-transform: uppercase; }

    /* Right History Bar */
    .history-column { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 4px; }
    .history-pill { width: 36px; height: 10px; border-radius: 5px; }

    /* 2x2 Betting Grid */
    .bet-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 12px; }
    .card-bet { height: 86px; border-radius: 16px; display: flex; flex-direction: column; justify-content: center; align-items: center; cursor: pointer; transition: transform 0.15s, filter 0.15s; position: relative; box-shadow: 0 6px 16px rgba(0,0,0,0.25); }
    .card-bet:active { transform: scale(0.96); }
    .card-bet.card-2x { background: #9CA3AF; color: #111827; }
    .card-bet.card-3x { background: #8B5CF6; color: white; }
    .card-bet.card-5x { background: #F97316; color: white; }
    .card-bet.card-30x { background: #10B981; color: white; }
    
    .card-bet .mult-val { font-size: 32px; font-weight: 900; letter-spacing: -0.5px; }
    .card-bet .placed-badge { position: absolute; bottom: 6px; background: rgba(0,0,0,0.4); color: white; font-size: 11px; font-weight: 800; padding: 2px 8px; border-radius: 10px; }

    /* Bottom Chip Bar */
    .chip-bar { background: #3B3448; border-radius: 20px; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; }
    .chip-btn { background: #4D455D; color: #D1D5DB; border: none; padding: 10px 14px; border-radius: 14px; font-size: 13px; font-weight: 800; cursor: pointer; transition: all 0.2s; }
    .chip-btn.active { background: #181124; color: #FFFFFF; border: 2px solid #FACE15; box-shadow: 0 0 10px rgba(250, 206, 21, 0.4); }
    .chip-btn .inr-tag { background: #FACE15; color: #000000; font-size: 9px; padding: 2px 4px; border-radius: 4px; margin-right: 4px; font-weight: 900; }
  </style>
</head>
<body>
  <div class="game-container">
    <!-- Top Header -->
    <div class="top-header">
      <button class="btn-back" onclick="goBack()">◄ Back</button>
      <div class="wallet-chip-container" onclick="openDeposit()">
        <div class="wallet-pill-bg">
          <span class="wallet-amount-text" id="walletText">${(wallet.totalPaise / 100).toFixed(2)}</span>
        </div>
        <div class="wallet-coin-icon">⭐</div>
      </div>
    </div>

    <!-- Canvas Stage Area -->
    <div class="canvas-stage">
      <div style="position: relative; width: 340px; height: 340px; display: flex; justify-content: center; align-items: center;">
        <canvas id="wheelCanvas" width="340" height="340"></canvas>
        <div class="wheel-arrow"></div>
      </div>
      
      <!-- Center Status Pill -->
      <div class="center-overlay" id="centerOverlay">
        <div class="timer-val" id="timerText">15s</div>
        <div class="phase-label" id="phaseText">PLACE BETS</div>
      </div>

      <!-- Right History Column -->
      <div class="history-column" id="historyColumn"></div>
    </div>

    <!-- 2x2 Betting Grid -->
    <div>
      <div class="bet-grid">
        <div class="card-bet card-2x" onclick="placeBet('2x')">
          <div class="mult-val">2x</div>
          <div class="placed-badge" id="betBadge2x" style="display:none;">0</div>
        </div>
        <div class="card-bet card-3x" onclick="placeBet('3x')">
          <div class="mult-val">3x</div>
          <div class="placed-badge" id="betBadge3x" style="display:none;">0</div>
        </div>
        <div class="card-bet card-5x" onclick="placeBet('5x')">
          <div class="mult-val">5x</div>
          <div class="placed-badge" id="betBadge5x" style="display:none;">0</div>
        </div>
        <div class="card-bet card-30x" onclick="placeBet('30x')">
          <div class="mult-val">30x</div>
          <div class="placed-badge" id="betBadge30x" style="display:none;">0</div>
        </div>
      </div>

      <!-- Bottom Chip Selection Bar (Numbers only, no currency symbol) -->
      <div class="chip-bar">
        <button class="chip-btn active" onclick="selectChip(10, this)">10</button>
        <button class="chip-btn" onclick="selectChip(500, this)">500</button>
        <button class="chip-btn" onclick="selectChip(2000, this)">2K</button>
        <button class="chip-btn" onclick="selectChip(5000, this)">5K</button>
        <button class="chip-btn" onclick="selectChip(20000, this)">20K</button>
      </div>
    </div>
  </div>

  <script>
    const userId = ${JSON.stringify(userId)};
    const authToken = ${JSON.stringify(pageJwt)};
    const payAccessTicket = ${JSON.stringify(payTicket)};
    let selectedChipRupees = 10;
    let currentPhase = "${initialState.phase}";
    let targetSegmentIndex = ${initialState.winningSegmentIndex};
    let currentRotationDeg = 0;
    let isSpinningAnimation = false;
    let lastSpunRoundId = null;

    // 32 Segment Colors
    const SEGMENT_COLORS = [
      '#10B981', '#9CA3AF', '#8B5CF6', '#9CA3AF', '#F97316', '#9CA3AF', '#8B5CF6', '#9CA3AF',
      '#F97316', '#9CA3AF', '#8B5CF6', '#9CA3AF', '#8B5CF6', '#9CA3AF', '#F97316', '#9CA3AF',
      '#8B5CF6', '#9CA3AF', '#8B5CF6', '#9CA3AF', '#F97316', '#9CA3AF', '#8B5CF6', '#9CA3AF',
      '#F97316', '#9CA3AF', '#8B5CF6', '#9CA3AF', '#8B5CF6', '#9CA3AF', '#F97316', '#8B5CF6'
    ];

    const canvas = document.getElementById('wheelCanvas');
    const ctx = canvas.getContext('2d');
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const outerRadius = 155;
    const innerRadius = 85;

    // Render 32 Segments ONCE to GPU texture
    function initWheelTexture() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const totalSegments = 32;
      const anglePerSegment = (2 * Math.PI) / totalSegments;

      ctx.save();
      ctx.translate(centerX, centerY);

      for (let i = 0; i < totalSegments; i++) {
        // Segment 0 (30x Green) is centered at 12 o'clock (-Math.PI / 2) under needle
        const midAngle = -Math.PI / 2 + i * anglePerSegment;
        const startAngle = midAngle - anglePerSegment / 2;
        const endAngle = midAngle + anglePerSegment / 2;

        ctx.beginPath();
        ctx.arc(0, 0, outerRadius, startAngle, endAngle);
        ctx.arc(0, 0, innerRadius, endAngle, startAngle, true);
        ctx.closePath();

        ctx.fillStyle = SEGMENT_COLORS[i];
        ctx.fill();

        ctx.lineWidth = 1.2;
        ctx.strokeStyle = '#0A0C11';
        ctx.stroke();
      }

      ctx.restore();
    }

    initWheelTexture();

    function selectChip(amount, btn) {
      selectedChipRupees = amount;
      document.querySelectorAll('.chip-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    }

    function goBack() {
      if (window.AndroidBridge && window.AndroidBridge.closeGame) {
        window.AndroidBridge.closeGame();
      } else {
        window.history.back();
      }
    }

    function openDeposit() {
      window.location.href = '/pay?ticket=' + encodeURIComponent(payAccessTicket) + '&amount=500';
    }

    async function placeBet(multiplierType) {
      if (currentPhase !== 'BETTING') {
        alert('Bets are locked for this round!');
        return;
      }

      try {
        const headers = { 'Content-Type': 'application/json' };
        if (authToken) {
          headers['Authorization'] = 'Bearer ' + authToken;
        }
        const res = await fetch('/api/v1/ring-of-future/bet', {
          method: 'POST',
          headers,
          body: JSON.stringify({ userId, multiplierType, amountRupees: selectedChipRupees, token: authToken })
        });
        const data = await res.json();
        if (data.success) {
          updateUI(data.data);
        } else {
          alert(data.message || 'Bet placement failed');
        }
      } catch (e) {
        alert('Network error placing bet');
      }
    }

    function updateUI(data) {
      if (!data) return;
      const state = data.gameState;
      const wallet = data.wallet;

      currentPhase = state.phase;
      document.getElementById('walletText').innerText = (wallet.totalPaise / 100).toFixed(2);
      document.getElementById('timerText').innerText = state.secondsRemaining + 's';

      if (state.phase === 'BETTING') {
        document.getElementById('phaseText').innerText = 'PLACE BETS';
        // Always show 30x Green centered under needle during loading / bet placing
        const targetDeg = Math.ceil(currentRotationDeg / 360) * 360;
        if (currentRotationDeg !== targetDeg && !isSpinningAnimation) {
          canvas.style.transition = 'transform 1.2s cubic-bezier(0.25, 1, 0.5, 1)';
          canvas.style.transform = 'rotate(' + targetDeg + 'deg) translate3d(0, 0, 0)';
          currentRotationDeg = targetDeg;
        }
      } else if (state.phase === 'LOCKED') {
        document.getElementById('phaseText').innerText = 'LOCKED';
      } else if (state.phase === 'SPINNING') {
        document.getElementById('phaseText').innerText = 'SPINNING';
        if (lastSpunRoundId !== state.roundId) {
          lastSpunRoundId = state.roundId;
          triggerSpinAnimation(state.winningSegmentIndex);
        }
      } else if (state.phase === 'RESULT_SHOW') {
        document.getElementById('phaseText').innerText = 'WIN: ' + state.winningType;
      }

      // Update User Bets Badges (Numbers only)
      updateBetBadge('betBadge2x', state.userBets.grey2x);
      updateBetBadge('betBadge3x', state.userBets.purple3x);
      updateBetBadge('betBadge5x', state.userBets.orange5x);
      updateBetBadge('betBadge30x', state.userBets.green30x);

      // Render History Column
      renderHistory(state.recentResults || []);
    }

    function updateBetBadge(elementId, paise) {
      const badge = document.getElementById(elementId);
      if (paise > 0) {
        badge.innerText = (paise / 100).toFixed(0);
        badge.style.display = 'block';
      } else {
        badge.style.display = 'none';
      }
    }

    function renderHistory(results) {
      const historyCol = document.getElementById('historyColumn');
      historyCol.innerHTML = results.slice(0, 10).map(type => {
        let color = '#9CA3AF';
        if (type === '3x') color = '#8B5CF6';
        if (type === '5x') color = '#F97316';
        if (type === '30x') color = '#10B981';
        return '<div class="history-pill" style="background: ' + color + ';"></div>';
      }).join('');
    }

    // 120 FPS GPU Composited Wheel Animation
    function triggerSpinAnimation(winningIndex) {
      if (isSpinningAnimation) return;
      isSpinningAnimation = true;

      const totalSegments = 32;
      const degPerSegment = 360 / totalSegments;
      // Segment 0 (30x Green) is centered at 12 o'clock (-90 deg).
      // Segment i is located at (i * degPerSegment) clockwise from 12 o'clock.
      // Rotating clockwise brings segment i directly under the 12 o'clock needle:
      const spinOffset = (360 - ((winningIndex * degPerSegment) % 360)) % 360;
      const currentMod = ((currentRotationDeg % 360) + 360) % 360;
      let forwardDegrees = spinOffset - currentMod;
      if (forwardDegrees <= 0) {
        forwardDegrees += 360;
      }
      const extraSpins = 5 * 360;
      const targetDeg = currentRotationDeg + extraSpins + forwardDegrees;
      currentRotationDeg = targetDeg;

      canvas.style.transition = 'transform 4.5s cubic-bezier(0.12, 0.85, 0.22, 1)';
      canvas.style.willChange = 'transform';
      canvas.style.transform = 'rotate(' + targetDeg + 'deg) translate3d(0, 0, 0)';

      setTimeout(() => {
        isSpinningAnimation = false;
      }, 4600);
    }

    // Auto Poll State every 1s
    async function syncState() {
      try {
        const headers = {};
        if (authToken) {
          headers['Authorization'] = 'Bearer ' + authToken;
        }
        const res = await fetch('/api/v1/ring-of-future/state', { headers });
        const data = await res.json();
        if (data.success) {
          updateUI(data.data);
        }
      } catch (e) {}
    }

    setInterval(syncState, 1000);
    syncState();
  </script>
</body>
</html>
  `;

  // Smart caching: Page shell cached locally; state is live-polled
  res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=86400');
  res.send(html);
});
