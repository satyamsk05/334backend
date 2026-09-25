/**
 * Ring of Future HTML5 PixiJS Engine
 * Implements genuine PixiJS v7 WebGL Application, Stage Containers, Graphics & State Sync
 */

(function () {
  const urlParams = new URLSearchParams(window.location.search);
  const userId = urlParams.get('userId') || '';

  let selectedChipRupees = 10;
  let currentPhase = 'BETTING';
  let isSpinningAnimation = false;

  // 32 Segment Colors Spec (~95% RTP)
  const SEGMENT_COLORS = [
    '#10B981', '#9CA3AF', '#8B5CF6', '#9CA3AF', '#F97316', '#9CA3AF', '#8B5CF6', '#9CA3AF',
    '#F97316', '#9CA3AF', '#8B5CF6', '#9CA3AF', '#8B5CF6', '#9CA3AF', '#F97316', '#9CA3AF',
    '#8B5CF6', '#9CA3AF', '#8B5CF6', '#9CA3AF', '#F97316', '#9CA3AF', '#8B5CF6', '#9CA3AF',
    '#F97316', '#9CA3AF', '#8B5CF6', '#9CA3AF', '#8B5CF6', '#9CA3AF', '#F97316', '#8B5CF6'
  ];

  // Initialize PixiJS Application
  const stageWidth = 340;
  const stageHeight = 340;
  const centerX = stageWidth / 2;
  const centerY = stageHeight / 2;
  const outerRadius = 155;
  const innerRadius = 85;

  const app = new PIXI.Application({
    width: stageWidth,
    height: stageHeight,
    backgroundAlpha: 0,
    antialias: true
  });

  const containerElem = document.getElementById('wheelCanvasContainer');
  if (containerElem) {
    containerElem.appendChild(app.view);
  }

  // Wheel Container for Rotation
  const wheelContainer = new PIXI.Container();
  wheelContainer.x = centerX;
  wheelContainer.y = centerY;
  app.stage.addChild(wheelContainer);

  // Render 32 Segments via PixiJS Graphics
  const segmentsGraphic = new PIXI.Graphics();
  const totalSegments = 32;
  const anglePerSegment = (2 * Math.PI) / totalSegments;

  for (let i = 0; i < totalSegments; i++) {
    const startAngle = i * anglePerSegment;
    const endAngle = startAngle + anglePerSegment;
    const colorHex = parseInt(SEGMENT_COLORS[i].replace('#', '0x'), 16);

    segmentsGraphic.beginFill(colorHex);
    segmentsGraphic.arc(0, 0, outerRadius, startAngle, endAngle);
    segmentsGraphic.arc(0, 0, innerRadius, endAngle, startAngle, true);
    segmentsGraphic.closePath();
    segmentsGraphic.endFill();

    segmentsGraphic.lineStyle(1.5, 0x222222);
    segmentsGraphic.arc(0, 0, outerRadius, startAngle, endAngle);
    segmentsGraphic.arc(0, 0, innerRadius, endAngle, startAngle, true);
  }

  wheelContainer.addChild(segmentsGraphic);

  // Top Pointer Arrow Graphic
  const pointerGraphic = new PIXI.Graphics();
  pointerGraphic.beginFill(0xFFFFFF);
  pointerGraphic.moveTo(centerX - 10, centerY - outerRadius - 4);
  pointerGraphic.lineTo(centerX + 10, centerY - outerRadius - 4);
  pointerGraphic.lineTo(centerX, centerY - outerRadius + 12);
  pointerGraphic.closePath();
  pointerGraphic.endFill();
  app.stage.addChild(pointerGraphic);

  // Global functions exposed to UI
  window.selectChip = function (amount, btn) {
    selectedChipRupees = amount;
    document.querySelectorAll('.chip-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  };

  window.goBack = function () {
    if (window.AndroidBridge && window.AndroidBridge.closeGame) {
      window.AndroidBridge.closeGame();
    } else {
      window.history.back();
    }
  };

  window.openDeposit = function () {
    window.location.href = '/pay?userId=' + userId + '&amount=500';
  };

  window.placeBet = async function (multiplierType) {
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
  };

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
    if (badge) {
      if (paise > 0) {
        badge.innerText = '₹' + (paise / 100).toFixed(0);
        badge.style.display = 'block';
      } else {
        badge.style.display = 'none';
      }
    }
  }

  function renderHistory(results) {
    const historyCol = document.getElementById('historyColumn');
    if (!historyCol) return;
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

    const anglePerSegment = (2 * Math.PI) / totalSegments;
    const targetRotation = (3 * 2 * Math.PI) - (winningIndex * anglePerSegment);

    let start = null;
    const duration = 4000;

    function step(timestamp) {
      if (!start) start = timestamp;
      const progress = Math.min((timestamp - start) / duration, 1);
      const easeOut = 1 - Math.pow(1 - progress, 3);
      
      // Update PixiJS Wheel Container Rotation
      wheelContainer.rotation = targetRotation * easeOut;

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
})();
