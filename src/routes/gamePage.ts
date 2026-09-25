import { Router, Request, Response } from 'express';
import { RingOfFutureEngine, MultiplierType } from '../game/RingOfFutureEngine';
import { WalletLedger } from '../services/WalletLedger';

export const gamePageRouter = Router();

gamePageRouter.get('/api/v1/ring-of-future/state', async (req: Request, res: Response) => {
  const userId = (req.query.userId as string) || '';
  const state = RingOfFutureEngine.getSnapshotForUser(userId);
  const wallet = userId ? await WalletLedger.getUserBalance(userId) : { depositPaise: 0, winningPaise: 0, bonusPaise: 0, totalPaise: 0 };
  res.json({ success: true, data: { gameState: state, wallet } });
});

gamePageRouter.post('/api/v1/ring-of-future/bet', async (req: Request, res: Response) => {
  const { userId, multiplierType, amountRupees } = req.body;
  if (!userId || typeof userId !== 'string' || !userId.trim()) {
    return res.status(400).json({ success: false, message: 'Valid userId is required' });
  }
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
  const rawUserId = (req.query.userId as string);
  if (!rawUserId || !/^[a-zA-Z0-9_-]+$/.test(rawUserId)) {
    return res.status(400).send('<div style="padding: 20px; font-family: sans-serif; text-align: center; color: red;"><h3>Error: Valid userId parameter is required to access Ring of Future.</h3></div>');
  }
  const userId = rawUserId;
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
    .wallet-pill { background: #10B981; color: white; padding: 6px 14px; border-radius: 20px; display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 800; cursor: pointer; box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3); }
    .wallet-pill span.plus { font-size: 16px; border-left: 1px solid rgba(255,255,255,0.3); padding-left: 8px; }

    /* Canvas Stage Area */
    .canvas-stage { width: 100%; position: relative; display: flex; justify-content: center; align-items: center; margin: 10px 0; }
    canvas { display: block; max-width: 100%; }

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
      <div class="wallet-pill" onclick="openDeposit()">
        <span id="walletText">₹${(wallet.totalPaise / 100).toFixed(2)}</span>
        <span class="plus">+</span>
      </div>
    </div>

    <!-- Canvas Stage Area -->
    <div class="canvas-stage">
      <canvas id="wheelCanvas" width="340" height="340"></canvas>
      
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
          <div class="placed-badge" id="betBadge2x" style="display:none;">₹0</div>
        </div>
        <div class="card-bet card-3x" onclick="placeBet('3x')">
          <div class="mult-val">3x</div>
          <div class="placed-badge" id="betBadge3x" style="display:none;">₹0</div>
        </div>
        <div class="card-bet card-5x" onclick="placeBet('5x')">
          <div class="mult-val">5x</div>
          <div class="placed-badge" id="betBadge5x" style="display:none;">₹0</div>
        </div>
        <div class="card-bet card-30x" onclick="placeBet('30x')">
          <div class="mult-val">30x</div>
          <div class="placed-badge" id="betBadge30x" style="display:none;">₹0</div>
        </div>
      </div>

      <!-- Bottom Chip Selection Bar -->
      <div class="chip-bar">
        <button class="chip-btn active" onclick="selectChip(10, this)"><span class="inr-tag">INR</span>10</button>
        <button class="chip-btn" onclick="selectChip(500, this)">500</button>
        <button class="chip-btn" onclick="selectChip(2000, this)">2K</button>
        <button class="chip-btn" onclick="selectChip(5000, this)">5K</button>
        <button class="chip-btn" onclick="selectChip(20000, this)">20K</button>
      </div>
    </div>
  </div>

  <script>
    const userId = ${JSON.stringify(userId)};
    let selectedChipRupees = 10;
    let currentPhase = "${initialState.phase}";
    let targetSegmentIndex = ${initialState.winningSegmentIndex};
    let currentRotation = 0;
    let isSpinningAnimation = false;

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

    function drawWheel(rotationAngle) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const totalSegments = 32;
      const anglePerSegment = (2 * Math.PI) / totalSegments;

      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.rotate(rotationAngle);

      for (let i = 0; i < totalSegments; i++) {
        const startAngle = i * anglePerSegment;
        const endAngle = startAngle + anglePerSegment;

        ctx.beginPath();
        ctx.arc(0, 0, outerRadius, startAngle, endAngle);
        ctx.arc(0, 0, innerRadius, endAngle, startAngle, true);
        ctx.closePath();

        ctx.fillStyle = SEGMENT_COLORS[i];
        ctx.fill();

        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#222222';
        ctx.stroke();
      }

      ctx.restore();

      // Draw Top Indicator Arrow (Pointing Down at top segment)
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.moveTo(centerX - 10, centerY - outerRadius - 4);
      ctx.lineTo(centerX + 10, centerY - outerRadius - 4);
      ctx.lineTo(centerX, centerY - outerRadius + 12);
      ctx.closePath();
      ctx.fill();
    }

    drawWheel(0);

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
      window.location.href = '/pay?userId=' + userId + '&amount=500';
    }

    async function placeBet(multiplierType) {
      if (currentPhase !== 'BETTING') {
        alert('Bets are locked for this round!');
        return;
      }

      try {
        const res = await fetch('/api/v1/ring-of-future/bet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, multiplierType, amountRupees: selectedChipRupees })
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
      document.getElementById('walletText').innerText = '₹' + (wallet.totalPaise / 100).toFixed(2);
      document.getElementById('timerText').innerText = state.secondsRemaining + 's';

      if (state.phase === 'BETTING') {
        document.getElementById('phaseText').innerText = 'PLACE BETS';
      } else if (state.phase === 'LOCKED') {
        document.getElementById('phaseText').innerText = 'LOCKED';
      } else if (state.phase === 'SPINNING') {
        document.getElementById('phaseText').innerText = 'SPINNING';
        triggerSpinAnimation(state.winningSegmentIndex);
      } else if (state.phase === 'RESULT_SHOW') {
        document.getElementById('phaseText').innerText = 'WIN: ' + state.winningType;
      }

      // Update User Bets Badges
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
        badge.innerText = '₹' + (paise / 100).toFixed(0);
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

    function triggerSpinAnimation(winningIndex) {
      if (isSpinningAnimation) return;
      isSpinningAnimation = true;

      const totalSegments = 32;
      const anglePerSegment = (2 * Math.PI) / totalSegments;
      const targetAngle = (3 * 2 * Math.PI) - (winningIndex * anglePerSegment);

      let start = null;
      const duration = 4000;

      function step(timestamp) {
        if (!start) start = timestamp;
        const progress = Math.min((timestamp - start) / duration, 1);
        const easeOut = 1 - Math.pow(1 - progress, 3);
        currentRotation = targetAngle * easeOut;

        drawWheel(currentRotation);

        if (progress < 1) {
          requestAnimationFrame(step);
        } else {
          isSpinningAnimation = false;
        }
      }

      requestAnimationFrame(step);
    }

    // Auto Poll State every 1s
    async function syncState() {
      try {
        const res = await fetch('/api/v1/ring-of-future/state?userId=' + userId);
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

  res.send(html);
});
