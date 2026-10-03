import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';
import jwt from 'jsonwebtoken';
import { FinancialService } from '../services/FinancialService';
import { envConfig } from '../config/env.config';
import { authenticateJwt } from '../modules/auth/auth.middleware';
import { PageAccessTicket } from '../services/PageAccessTicket';

export const depositPageRouter = Router();

const MERCHANT_UPI_ID = process.env.PAYMENT_UPI_ID || process.env.MERCHANT_UPI_ID || 'satyamskk@ptyes';
const MERCHANT_NAME = process.env.PAYMENT_MERCHANT_NAME || process.env.MERCHANT_NAME || 'satyam';

function resolveBearerUserId(req: Request): string {
  const authHeader = req.headers.authorization;
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (bearer) {
    try {
      const decoded: any = jwt.verify(bearer, envConfig.jwtSecret);
      return decoded.userId || decoded.id || '';
    } catch {
      // fall through
    }
  }
  return '';
}

// Deposit Initiate API (Requires valid JWT authentication)
depositPageRouter.post('/api/v1/deposits/initiate', authenticateJwt, async (req: Request, res: Response) => {
  const authenticatedUserId = (req as any).user?.userId || (req as any).user?.id;
  if (!authenticatedUserId) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  const { userId, amountRupees } = req.body;
  if (userId && userId !== authenticatedUserId) {
    return res.status(403).json({ success: false, message: 'Forbidden: You cannot initiate deposits for another user' });
  }
  const effectiveUserId = authenticatedUserId;

  const num = parseFloat(amountRupees);
  if (isNaN(num) || num <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid deposit amount' });
  }

  // Reuse pending deposit if existing within 15 minutes to avoid duplicates
  const pending = FinancialService.getPendingDeposits();
  const existing = pending.find(
    (d) => d.userId === effectiveUserId && Math.abs(d.amountRupees - num) < 0.01 && Date.now() - d.createdAt < 15 * 60 * 1000
  );

  const order = existing || FinancialService.initiateDeposit(effectiveUserId, num);
  const ticket = await PageAccessTicket.issue(effectiveUserId, 'pay', {
    orderId: order.depositId,
    amountRupees: order.amountRupees,
  });

  const gatewayBase = process.env.PAYMENT_GATEWAY_URL || 'https://bitarcade-pay.vercel.app';
  const payPath = `/pay?ticket=${encodeURIComponent(ticket)}&orderId=${encodeURIComponent(order.depositId)}&amount=${order.amountRupees}`;
  const paymentUrl = `${gatewayBase.replace(/\/$/, '')}${payPath}`;

  res.json({
    success: true,
    data: {
      depositId: order.depositId,
      amountRupees: order.amountRupees,
      payUrl: payPath,
      paymentUrl: paymentUrl
    }
  });
});

/** Mint a short-lived opaque pay ticket so clients never put session JWTs in browser URLs. */
depositPageRouter.post('/api/v1/deposits/pay-session', authenticateJwt, async (req: Request, res: Response) => {
  const authenticatedUserId = (req as any).user?.userId || (req as any).user?.id;
  if (!authenticatedUserId) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  const amountRaw = parseFloat(req.body?.amountRupees);
  const amountRupees = Math.max(1, Math.min(50000, isNaN(amountRaw) ? 200 : amountRaw));

  const pending = FinancialService.getPendingDeposits();
  const existing = pending.find(
    (d) => d.userId === authenticatedUserId && Math.abs(d.amountRupees - amountRupees) < 0.01 && Date.now() - d.createdAt < 15 * 60 * 1000
  );
  const order = existing || FinancialService.initiateDeposit(authenticatedUserId, amountRupees);

  const ticket = await PageAccessTicket.issue(authenticatedUserId, 'pay', {
    orderId: order.depositId,
    amountRupees: order.amountRupees,
  });

  const gatewayBase = process.env.PAYMENT_GATEWAY_URL || 'https://bitarcade-pay.vercel.app';
  const payPath = `/pay?ticket=${encodeURIComponent(ticket)}&orderId=${encodeURIComponent(order.depositId)}&amount=${order.amountRupees}`;
  const paymentUrl = `${gatewayBase.replace(/\/$/, '')}${payPath}`;

  return res.json({
    success: true,
    data: {
      ticket,
      depositId: order.depositId,
      amountRupees: order.amountRupees,
      payUrl: payPath,
      paymentUrl: paymentUrl,
    },
  });
});

// Deposit Status Polling API
depositPageRouter.get('/api/v1/deposits/status', (req: Request, res: Response) => {
  const rawId = (req.query.orderId as string) || (req.query.depositId as string) || '';
  if (!rawId) {
    return res.status(400).json({ success: false, message: 'orderId or depositId is required' });
  }

  const order = FinancialService.getDeposit(rawId);
  if (!order) {
    return res.status(404).json({ success: false, message: 'Deposit order not found' });
  }

  res.json({
    success: true,
    data: {
      depositId: order.depositId,
      userId: order.userId,
      amountRupees: order.amountRupees,
      amountPaise: order.amountPaise,
      status: order.status,
      utr: order.utr || '',
      createdAt: order.createdAt,
      updatedAt: order.updatedAt
    }
  });
});

// UTR Submission API (Requires valid JWT authentication)
depositPageRouter.post('/api/v1/deposits/submit-utr', authenticateJwt, (req: Request, res: Response) => {
  try {
    const authenticatedUserId = (req as any).user?.userId || (req as any).user?.id;
    if (!authenticatedUserId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const { depositId, utr, userId, amountRupees } = req.body;
    if (!depositId) {
      return res.status(400).json({ success: false, message: 'Deposit ID is required' });
    }

    if (userId && userId !== authenticatedUserId) {
      return res.status(403).json({ success: false, message: 'Forbidden: You cannot submit UTR for another user' });
    }

    const existingOrder = FinancialService.getDeposit(depositId);
    if (!existingOrder) {
      return res.status(404).json({ success: false, message: 'Deposit order not found' });
    }

    if (existingOrder.userId !== authenticatedUserId) {
      return res.status(403).json({ success: false, message: 'Forbidden: You do not own this deposit order' });
    }

    const parsedAmount = amountRupees ? parseFloat(amountRupees) : undefined;
    const result = FinancialService.submitUtr(depositId, utr, authenticatedUserId, parsedAmount);
    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json(result);
  } catch (err: any) {
    console.error('Error submitting UTR:', err);
    res.status(500).json({ success: false, message: err?.message || 'Error submitting UTR' });
  }
});

// Auto-UPI Payment Webpage — requires short-lived ?ticket=, verified ?token=, or Authorization Bearer JWT
depositPageRouter.get('/pay', async (req: Request, res: Response) => {
  const ticketParam = typeof req.query.ticket === 'string' ? req.query.ticket : '';
  const ticketPayload = await PageAccessTicket.resolve(ticketParam, 'pay');
  let authenticatedUserId = ticketPayload?.userId || resolveBearerUserId(req);

  // Fallback: verify token JWT param if ticket / bearer header wasn't present
  if (!authenticatedUserId) {
    const tokenParam = typeof req.query.token === 'string' ? req.query.token : '';
    if (tokenParam) {
      try {
        const decoded: any = jwt.verify(tokenParam, envConfig.jwtSecret);
        authenticatedUserId = decoded.userId || decoded.id || '';
      } catch {
        // invalid token
      }
    }
  }

  // Reject unauthenticated access
  if (!authenticatedUserId) {
    return res.status(401).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bit Arcade — Authentication Required</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Outfit', sans-serif; }
    body {
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      background: radial-gradient(circle at 50% 20%, #1e1035 0%, #0a0414 100%);
      color: #FFFFFF;
      padding: 24px;
      text-align: center;
    }
    .card {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border-radius: 24px;
      padding: 36px 24px;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
    }
    .badge-lock {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 20px;
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #F87171;
      font-size: 13px;
      font-weight: 700;
      margin-bottom: 20px;
    }
    h1 {
      font-size: 22px;
      font-weight: 800;
      margin-bottom: 12px;
      color: #FFFFFF;
    }
    p {
      color: #94A3B8;
      font-size: 14px;
      line-height: 1.6;
      margin-bottom: 20px;
    }
    .instructions {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 14px;
      padding: 14px 16px;
      font-size: 13px;
      color: #CBD5E1;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge-lock">🔒 Authentication Required</div>
    <h1>Authentication Required</h1>
    <p>Please open the deposit page directly from your Bit Arcade Game app to continue.</p>
    <div class="instructions">
      Open Bit Arcade App &rarr; Go to <strong>Add Cash</strong> &rarr; Select chips package to deposit.
    </div>
  </div>
</body>
</html>`);
  }

  const rawOrderId = (req.query.orderId as string) || ticketPayload?.orderId || '';
  let orderId = rawOrderId && /^[a-zA-Z0-9_-]+$/.test(rawOrderId) ? rawOrderId : '';
  const existingOrder = orderId ? FinancialService.getDeposit(orderId) : undefined;

  if (existingOrder && existingOrder.userId !== authenticatedUserId) {
    return res.status(403).send('<div style="padding: 20px; font-family: sans-serif; text-align: center; color: red;"><h3>Error: Unauthorized access to deposit order.</h3></div>');
  }

  const userId = authenticatedUserId;
  const amountStr = (req.query.amount as string) || String(ticketPayload?.amountRupees || '200');
  const amountRupees = Math.max(1, Math.min(50000, parseFloat(amountStr) || 200));

  // If visited with token instead of ticket, or without orderId, redirect to canonical ticket URL
  if (!orderId || (req.query.token && !ticketParam)) {
    const pending = FinancialService.getPendingDeposits();
    const existing = pending.find(
      (d) => d.userId === userId && Math.abs(d.amountRupees - amountRupees) < 0.01 && Date.now() - d.createdAt < 15 * 60 * 1000
    );

    if (existing) {
      orderId = existing.depositId;
    } else if (!orderId) {
      const order = FinancialService.initiateDeposit(userId, amountRupees);
      orderId = order.depositId;
    }

    // Canonical URL uses opaque ticket only — never session JWT in browser history
    const redirectTicket = await PageAccessTicket.issue(userId, 'pay', { orderId, amountRupees });
    return res.redirect(
      302,
      `/pay?ticket=${encodeURIComponent(redirectTicket)}&orderId=${encodeURIComponent(orderId)}&amount=${amountRupees}`
    );
  }

  // Load order details
  const currentOrder = existingOrder || FinancialService.getDeposit(orderId);
  const finalAmount = currentOrder ? currentOrder.amountRupees : amountRupees;
  const initialStatus = currentOrder ? currentOrder.status : 'PENDING';
  const hasUtr = !!(currentOrder && currentOrder.utr);

  const upiIntentUri = `upi://pay?pa=${encodeURIComponent(MERCHANT_UPI_ID)}&pn=${encodeURIComponent(MERCHANT_NAME)}&am=${finalAmount.toFixed(2)}&cu=INR&tr=${orderId}`;

  let qrCodeDataUrl = '';
  try {
    qrCodeDataUrl = await QRCode.toDataURL(upiIntentUri, { margin: 1, width: 280 });
  } catch (e) {
    qrCodeDataUrl = '';
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>Deposit — Bit Arcade Pay</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
      font-family: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif;
      -webkit-tap-highlight-color: transparent;
    }
    body {
      background: #0E0720 radial-gradient(circle at 50% 0%, #221040 0%, #0E0720 70%);
      color: #FFFFFF;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 16px 12px 32px 12px;
      position: relative;
      overflow-x: hidden;
    }
    
    .top-header {
      width: 100%;
      max-width: 400px;
      display: flex;
      align-items: center;
      position: relative;
      padding: 12px 4px 18px 4px;
    }
    .back-btn {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: #1C1236;
      border: 1px solid rgba(255, 255, 255, 0.1);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #FFFFFF;
      cursor: pointer;
      position: absolute;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
      transition: background 0.2s;
    }
    .back-btn:active {
      background: #2E1F55;
    }
    .header-text {
      width: 100%;
      text-align: center;
    }
    .header-title {
      font-size: 20px;
      font-weight: 800;
      color: #FFFFFF;
      letter-spacing: -0.3px;
    }
    .header-subtitle {
      font-size: 13px;
      color: #A195BE;
      margin-top: 2px;
      font-weight: 500;
    }

    .card-upi {
      background: #FFFFFF;
      width: 100%;
      max-width: 400px;
      border-radius: 32px;
      padding: 22px 20px 22px 20px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5), 0 0 1px rgba(255, 255, 255, 0.2);
      color: #111827;
      position: relative;
      overflow: hidden;
    }

    .bhim-row {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
    }
    .bhim-brand {
      font-size: 22px;
      font-weight: 900;
      font-style: italic;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, #097939 0%, #0054A6 50%, #F37023 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .upi-pill {
      background: #097939;
      color: #FFFFFF;
      font-size: 11.5px;
      font-weight: 800;
      padding: 2px 7px;
      border-radius: 4px;
      letter-spacing: 0.5px;
    }
    .pay-title {
      text-align: center;
      font-size: 18px;
      font-weight: 800;
      color: #111827;
      letter-spacing: 0.2px;
    }
    .pay-sub {
      text-align: center;
      font-size: 13px;
      color: #6B7280;
      margin-top: 2px;
      margin-bottom: 16px;
      font-weight: 500;
    }

    .amount-box {
      background: #F8FAFC;
      border: 1px solid #E2E8F0;
      border-radius: 16px;
      padding: 11px 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .amount-box-label {
      font-size: 14px;
      font-weight: 600;
      color: #4B5563;
    }
    .amount-right {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .amount-val {
      font-size: 22px;
      font-weight: 800;
      color: #0F172A;
      letter-spacing: -0.5px;
    }
    .edit-btn {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: #EEF2F6;
      border: 1px solid #CBD5E1;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      color: #475569;
      transition: background 0.15s;
    }
    .edit-btn:active {
      background: #E2E8F0;
    }

    .qr-container {
      background: #FFFFFF;
      border: 1.5px solid #F1F5F9;
      border-radius: 24px;
      padding: 10px;
      display: flex;
      justify-content: center;
      align-items: center;
      margin-bottom: 18px;
      box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.02);
      min-height: 250px;
    }
    .qr-container svg {
      width: 234px;
      height: 234px;
      display: block;
    }

    .apps-row {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 6px;
      margin-bottom: 18px;
    }
    .app-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      text-decoration: none;
      color: inherit;
      padding: 4px 0;
      border-radius: 12px;
      transition: transform 0.15s;
    }
    .app-item:active {
      transform: scale(0.92);
    }
    .app-icon {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 10px rgba(0, 0, 0, 0.08);
      overflow: hidden;
      background: #FFFFFF;
      border: 1px solid #F1F5F9;
    }
    .app-icon img, .app-icon svg {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .app-name {
      font-size: 11px;
      font-weight: 600;
      color: #374151;
      text-align: center;
      white-space: nowrap;
    }

    .divider-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
    }
    .divider-line {
      flex: 1;
      height: 1px;
      background: #E5E7EB;
    }
    .divider-text {
      font-size: 11px;
      font-weight: 700;
      color: #9CA3AF;
      letter-spacing: 0.5px;
    }

    .utr-section {
      margin-bottom: 14px;
    }
    .utr-label {
      font-size: 11.5px;
      font-weight: 800;
      color: #4B5563;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      margin-bottom: 8px;
      display: block;
    }
    .utr-input {
      width: 100%;
      background: #FFFFFF;
      border: 1.5px solid #CBD5E1;
      border-radius: 14px;
      padding: 13px 14px;
      font-size: 16px;
      font-weight: 700;
      text-align: center;
      letter-spacing: 1.5px;
      color: #0F172A;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
      margin-bottom: 12px;
    }
    .utr-input::placeholder {
      color: #94A3B8;
      font-weight: 500;
      letter-spacing: 1px;
    }
    .utr-input:focus {
      border-color: #10B981;
      box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.15);
    }
    .btn-submit {
      width: 100%;
      background: #00C853 linear-gradient(180deg, #10B981 0%, #059669 100%);
      color: #FFFFFF;
      border: none;
      border-radius: 14px;
      padding: 14px;
      font-size: 15px;
      font-weight: 800;
      letter-spacing: 0.5px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      box-shadow: 0 6px 16px rgba(16, 185, 129, 0.35);
      transition: transform 0.15s, opacity 0.15s;
    }
    .btn-submit:active {
      transform: scale(0.98);
    }
    .btn-submit:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .verify-note {
      text-align: center;
      font-size: 12px;
      color: #6B7280;
      font-weight: 500;
      line-height: 1.4;
    }

    .status-alert {
      padding: 10px 14px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 600;
      text-align: center;
      margin-bottom: 12px;
      display: none;
    }
    .status-alert.error {
      background: #FEE2E2;
      color: #B91C1C;
      border: 1px solid #FCA5A5;
      display: block;
    }
    .status-alert.success {
      background: #D1FAE5;
      color: #065F46;
      border: 1px solid #6EE7B7;
      display: block;
    }

    .card-success {
      display: none;
      background: #FFFFFF;
      width: 100%;
      max-width: 400px;
      border-radius: 32px;
      overflow: hidden;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
      text-align: center;
      animation: popIn 0.35s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .card-success.active {
      display: block;
    }
    .success-hero {
      background: linear-gradient(180deg, #059669 0%, #10B981 100%);
      padding: 36px 20px 24px 20px;
      color: #FFFFFF;
    }
    .check-wrap {
      width: 68px;
      height: 68px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.2);
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 16px auto;
    }
    .check-inner {
      width: 50px;
      height: 50px;
      border-radius: 50%;
      background: #FFFFFF;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .check-svg {
      width: 28px;
      height: 28px;
      stroke: #059669;
      stroke-width: 3.5;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .success-hero h2 {
      font-size: 22px;
      font-weight: 800;
    }
    .success-hero p {
      font-size: 13px;
      opacity: 0.9;
      margin-top: 4px;
    }
    .success-content {
      padding: 24px 20px;
    }
    .success-info-box {
      background: #F8FAFC;
      border: 1px solid #E2E8F0;
      border-radius: 16px;
      padding: 16px;
      margin-bottom: 20px;
      text-align: left;
    }
    .btn-return {
      width: 100%;
      background: #0E0720;
      color: #FFFFFF;
      border: none;
      border-radius: 14px;
      padding: 14px;
      font-size: 15px;
      font-weight: 800;
      cursor: pointer;
    }
    @keyframes popIn {
      from { transform: scale(0.9); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }
  </style>
</head>
<body>

  <!-- Top Header Navigation -->
  <div class="top-header">
    <button class="back-btn" onclick="handleBack()" aria-label="Back">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="15 18 9 12 15 6"></polyline>
      </svg>
    </button>
    <div class="header-text">
      <h1 class="header-title">Deposit</h1>
      <p class="header-subtitle">Add money to your wallet</p>
    </div>
  </div>

  <!-- Primary White Payment Card -->
  <div class="card-upi" id="paymentCard">
    <!-- Brand -->
    <div class="bhim-row">
      <span class="bhim-brand">BHIM</span>
      <span class="upi-pill">UPI</span>
    </div>
    <h2 class="pay-title">PAY VIA UPI</h2>
    <p class="pay-sub" id="paySubText">Scan QR or pay to satyam</p>

    <!-- Amount Row with Edit Button -->
    <div class="amount-box">
      <span class="amount-box-label">Amount to Add</span>
      <div class="amount-right">
        <span class="amount-val" id="displayAmount">₹${finalAmount.toFixed(2)}</span>
        <button class="edit-btn" onclick="promptEditAmount()" title="Edit amount">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20h9"></path>
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
          </svg>
        </button>
      </div>
    </div>

    <!-- Circular QR Code Container -->
    <div class="qr-container" id="qrBox">
      <!-- SVG Circular QR will be injected here -->
    </div>

    <!-- UPI App Buttons -->
    <div class="apps-row">
      <div class="app-item" onclick="openUpiApp('phonepe')">
        <div class="app-icon">
          <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAACgBAMAAAB54XoeAAAAAXNSR0IArs4c6QAAACFQTFRFR3BMXyWfXySfXiOfXiSfXyWf////eUmvxK7cpIPI5dvwZL2jYAAAAAV0Uk5TAM9qJJimOUzHAAAEEUlEQVRo3t1bTVMaQRBFV+8ocl9NuG9MecdUeXfYHRfyAzbEO5hwdyvhDjHes378yiyluARmul8PY0ilb1rW8w39OT2PWo2146PTvabWau/g6E1tbXv/tsSqTH2I1oLbPtUrduBOMzjURtt3ZHnc1BZTTiQPNWH78uO2NGkHwmMHZ5qxRIQYNLX2igjgiRDPtPaKeKhBA339TsPWgNJNCyz04+CFnOE/xpYWGfsx7mihtX0eGDj0iRZbw5uHEU+3XAA7nglSFE05/LXI7gdMTgtCJh1npfUdQ2flE0xvsie7c6K4SnD4jMdSDEEX53PA7NrB0QYXT7N1KBqSpPcCmE1owBjM4oriJ3FGb5n+boEiE4t1sDFVFKWRY8m69AXwUugWW2eaopETg609RSNHoXVmhEZOCFbqtJgDfpacmWglIzByFFpZK4p3+JnJ6WMERk4dHbcqir/Q2A7ofz0CIyeCx4UCi5w23N4/YpET4xNrDlFU4EdY2hcsciJ84sqh4G7jE1IXipxYMPTnSHB3BLeSHlQWJSNSjkROaG9PdooTNp3BqXUKNNTYMoKk3ww2nlN8+nFi90rTPiQRdjmw5UpAtTrC7my5su0I2Le5ecsRMLO5+cQV0PQhnpuvEu6AHXMmuwMm5kx2B5zFjeHXFxDgxFweAnrOFDIsA3GbLNBUqljqjbH+p+PHx8fCivVzZj8sXWCLLS+DlVmRLGC7fgHPiWo4XfYmAhgTd24nhh0AcOIbUMjwzC9gQjRlpyMrAHCwYUDt+8jaL0Ptm6HeBMP/7sgbCOx/P/WEDAXlS0Ply3PFTjbRAq4lR+4AbfRa1kbtjX64cl+EGr19FLlYvulgo8gOuxjoSxi2iatjd3kQRBiGxH6gt3LFAQCjGlG/XkbLydJ/oG/MTX5dczkbLq9uMx5QkQuChctAOdAyd6jqWtHi9z/Ipay6+OzyXsEBY3pDUIgB6/QOYygGDOlFVVcMGDFrm0IIqLinspEQsMOtWdJCBhizi6CuDLDOr6puRYDPm2dyoTReuH9ygAp6wJw/xWUPVxxggi0k05vysnv/fcAX2Fj6SM0BtuGlLtgCIpHwggdMxO/eDGBMP8HJGS484vphGEnVJgzDhHt2lDJsiB/nGYahWLFDM1RywQTNMHYQJJCAoVylRDJULiIRCrDhIsLICcDQRUk1tAMm2JO6Zdixtqc/Hv3xMxt2myYZD+KWNLe8AsTO2pi0NMQlzuqdxRFkbUEVQxDW4CExsybFtlcNFCExcqUY/j2Zln8hmUTMSCXJK4rxvMsFBYpQ3iOvJLn0Lgr1L1v1L6wFpM5cDrshSuTOCKIS4PkXeJeIp0xAy5X3nkXyryDj9/9FgxlJ01chwto6Fvj9sobD10l+A1ELni9dtAl8AAAAAElFTkSuQmCC" alt="PhonePe">
        </div>
        <span class="app-name">PhonePe</span>
      </div>

      <div class="app-item" onclick="openUpiApp('gpay')">
        <div class="app-icon">
          <img src="data:image/png;base64,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" alt="Google Pay">
        </div>
        <span class="app-name">Google Pay</span>
      </div>

      <div class="app-item" onclick="openUpiApp('paytm')">
        <div class="app-icon">
          <img src="data:image/png;base64,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" alt="Paytm">
        </div>
        <span class="app-name">Paytm</span>
      </div>

      <div class="app-item" onclick="openUpiApp('whatsapp')">
        <div class="app-icon" style="background: #25D366;">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
            <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91C2.13 13.66 2.59 15.36 3.45 16.86L2.05 22L7.3 20.62C8.75 21.41 10.38 21.83 12.04 21.83C17.5 21.83 21.95 17.38 21.95 11.92C21.95 9.27 20.92 6.78 19.05 4.91C17.18 3.03 14.69 2 12.04 2ZM12.04 20.15C10.56 20.15 9.11 19.76 7.85 19.01L7.55 18.83L4.43 19.65L5.26 16.61L5.06 16.29C4.24 14.99 3.8 13.47 3.8 11.91C3.8 7.37 7.5 3.67 12.05 3.67C14.25 3.67 16.31 4.53 17.87 6.09C19.42 7.65 20.28 9.72 20.28 11.92C20.28 16.46 16.58 20.15 12.04 20.15ZM16.57 14.36C16.32 14.23 15.1 13.63 14.88 13.55C14.65 13.47 14.48 13.43 14.32 13.68C14.15 13.93 13.67 14.49 13.52 14.66C13.38 14.83 13.23 14.85 12.98 14.73C12.73 14.6 11.93 14.34 10.98 13.49C10.24 12.83 9.74 12.02 9.6 11.77C9.45 11.52 9.58 11.38 9.71 11.26C9.82 11.15 9.96 10.97 10.08 10.82C10.21 10.67 10.25 10.57 10.33 10.4C10.42 10.23 10.37 10.09 10.31 9.96C10.25 9.84 9.75 8.61 9.54 8.11C9.34 7.62 9.14 7.69 8.98 7.68C8.84 7.67 8.67 7.67 8.5 7.67C8.33 7.67 8.06 7.73 7.83 7.98C7.6 8.23 6.96 8.83 6.96 10.04C6.96 11.25 7.85 12.42 7.97 12.59C8.1 12.76 9.71 15.24 12.18 16.3C12.77 16.55 13.23 16.71 13.58 16.82C14.18 17.01 14.72 16.98 15.15 16.92C15.63 16.85 16.63 16.31 16.84 15.73C17.05 15.15 17.05 14.66 16.98 14.53C16.92 14.41 16.82 14.48 16.57 14.36Z" fill="white"/>
          </svg>
        </div>
        <span class="app-name">WhatsApp</span>
      </div>

      <div class="app-item" onclick="openUpiApp('any')">
        <div class="app-icon">
          <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAABQCAMAAAC5zwKfAAABKVBMVEXm5ubn5+fk5OTn5+fm5ubk5OTn5+fm5ubl5eXm5ubm5ubn5+fl5eXm5ubo6Ojn5+fm5ubl5eXm5ubf39/m5uYAAAD73sj97+To6Ojyi0HS6t3S6tyAlFIclFObgTL73smagTL7+/tYsYE6omv19fW3fy7zk06FxqPu7u7Ffiz5+fn4xJ9FiD+pgDD85tX09PTyikBwhDnFfSz1rHcrm1/73cn+9/Eqm1/0m1yz28Znt4zs7OwblFPxgjN+hDZYsIHz8/PC49Hr6+sMjUjh8ej5za3ieyf8/PxJqXb6+vqj1Lr61rvv7+/Kp3D97uP85tbyi0DweiX1o2kai0ak1Lrw+PT39/fx8fHn5+cpi0T29vYajEb2tIR2v5jp6en9/f3m5ub////y8vIQFjv7AAAAFnRSTlOgIGCfr5BgcIDvUEDPv29/j5/fEM8AfMCZ1gAAA/FJREFUWMO9mVt700YQhleOT7ItYmltCNDS0rpJMAWFQ9wQJYWgpCIlTREljhtAms3//xHswSSWY+2s7MDc6EZ6n29ndmdnRqSrN9qouY7nATe75bj1JkU+IFpYW5Ky5rkNOhewWbb556Pg9GwYRYxbetj3T4ORgLqNokC6LGiB32dX7NAPhM6SVQAoccmrlOVYdJZw5LIxsMo9F/SZ1oaBUGkEtBwcJ6zPVZYtHHjDhpHPjIwv3C4hQNoGWE+ZoUVHAG0t0GoZy1Pmj6Bl5QMtD5KIFbIoAc/KA3Le64I8TnydJZIsL2WFLc0SyaK8aeIlsDUnTxJb9AqwXTgemci0p4FVGM3N48QR1LJAywafLWA+2FYGWIYjtpCtgzMJrC7gwHFgRlCaAHpwZvLViXbRHr0ALkOiBR2vysf+G91LAdS/AvmW1ue/g/hAPD6Ee7r8CDYdA6sQ6Jf6Pn4nHi9DA4lEenCoB+7GUuJOiElUwAbiQbYZx0LiXhjqJSbQlMAlLMSfOJBL3OZArcRzKAsgBUD24JYAvhv8ESISUxEWwleMhGQQS/snDDGJATQ4cAk7xW8V8K//QkyiDxUO9OC+HvhMAeMnqMQ+eF1CYQU5cBtj4NMQlTgCSpqYCx/HX+13VCJ3IqnDqR748AL4GyrxFGqEYDHZis0l9sAlDpIY2CUPlzgEh3SQIG9OAFGJEXjEhhQ/d1MSf9UBAfQrXo1nSPyQ9zYABjzO8OJHCvjL/MCDLPBnBfw8P/B9hvfgf+XDfQ3Q0yevjUxMPkre9okmgSHAx5O8e2q92/mvH0KHb+yh0bm74K1prxWHH72e2bn7E+fxhOiSmi45DIrxeHKoE+0N8LYYj6evpj7BPpvi/Y3kYpFgu7o6ZKMY71BcAd1KfkI8zvB+fIGXna7+Gh2fux8U7y5a7qlrlOYnMHXuDnYMeRGAuOh5OXyeXyTFuz/dEbzn+3g9yi8AWds084olkax3/2UvDHm8WGqocs7OiTM/d7dvMbZmyBvyGCtgPScsW5LH3pjxeEhKYyCdLXGgeGzHjNdXHZ8s2mdL3FwdiMeeGY978KJo71Jv1ua+KXns7okRryc9eNn4rMzZiU70j5ONT9eB9cWAR6Ic/pbNY7cGK4u1t6XpBryyWANeudLR085CI4LvMcS49jHL9Q+Crn9UxYkdWLnOYZrcPXBkLDJdB6hQZCBZtSHpGcuzawYj0zJAYjIyDQAcy3yoO8RxhkNdmXE5Munl+jI9TwDsOi0wGLeESgj8GT1MXw7Gc3C60X2DgBrd+/378gBF0fBMje7tcnPOnwtk1s+Fypw/F8bQZt11OrYkeY5ba2C/P74A6SVY81U6htQAAAAASUVORK5CYII=" alt="Any UPI">
        </div>
        <span class="app-name">Any UPI</span>
      </div>
    </div>

    <!-- Divider -->
    <div class="divider-row">
      <div class="divider-line"></div>
      <span class="divider-text">OR</span>
      <div class="divider-line"></div>
    </div>

    <!-- UTR Input & Submit Form -->
    <div class="utr-section">
      <label class="utr-label" for="utrInput">ENTER 12-DIGIT UTR / REF NO.</label>
      <input type="text" class="utr-input" id="utrInput" placeholder="e.g. 426819203814" maxlength="16" autocomplete="off" autocorrect="off">
      
      <div class="status-alert" id="statusAlert"></div>

      <button class="btn-submit" id="submitBtn" onclick="submitUtr()">
        <span>SUBMIT PAYMENT</span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="5" y1="12" x2="19" y2="12"></line>
          <polyline points="12 5 19 12 12 19"></polyline>
        </svg>
      </button>
    </div>

    <p class="verify-note">Payment will be credited automatically after verification</p>
  </div>

  <!-- Success Card -->
  <div class="card-success" id="successCard">
    <div class="success-hero">
      <div class="check-wrap">
        <div class="check-inner">
          <svg class="check-svg" viewBox="0 0 24 24">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </div>
      </div>
      <h2>Payment Successful!</h2>
      <p>Funds added to your wallet</p>
    </div>
    <div class="success-content">
      <div class="success-info-box">
        <div style="font-size: 13px; color: #64748B; margin-bottom: 4px;">Amount Added</div>
        <div style="font-size: 26px; font-weight: 800; color: #0F172A;" id="successAmountText">₹${finalAmount.toFixed(2)}</div>
        <div style="font-size: 12px; color: #94A3B8; margin-top: 8px;" id="successOrderIdText">Order ID: ...</div>
      </div>
      <button class="btn-return" onclick="handleReturnToGame()">RETURN TO GAME</button>
    </div>
  </div>

  <!-- Injected Circular QR Code Engine -->
  <script>
// Ensure UTF-8 support for QRCode generator
if (typeof qrcode !== 'undefined' && qrcode.stringToBytesFuncs) {
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
}

// Pseudo-random number generator for deterministic procedural rings & dots
function rng(seed) {
  return function() {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

// Circular QR Code SVG Renderer
function circ(q, n, c, options) {
  var opts = typeof options === 'string' ? { text: options, fillDots: true } : (options || {});
  var fillDots = opts.fillDots !== undefined ? opts.fillDots : true;
  var text = opts.text || '';
  var logoImg = opts.logoImg || '';
  var isFixedDimensions = opts.fixedDimensions !== undefined ? opts.fixedDimensions : false;
  var fontWeight = opts.fontWeight || (typeof options === 'string' ? '800' : '700');

  var h = n / 2;
  var R0 = n * 0.71;
  var lr = n * 0.11;
  var W = 1.1;
  var SP = 2.1;
  var H = R0 + 1.3 + 2 * SP + W + 0.8;
  var o = '';

  var eye = function(r, k) {
    return (r < 7 && k < 7) || (r < 7 && k >= n - 7) || (r >= n - 7 && k < 7);
  };

  for (var r = 0; r < n; r++) {
    for (var k = 0; k < n; k++) {
      if (!q.isDark(r, k) || eye(r, k)) continue;
      var x = k + 0.5 - h;
      var y = r + 0.5 - h;
      if (Math.hypot(x, y) < lr + 0.9) continue;
      o += '<circle cx="' + x + '" cy="' + y + '" r=".47"/>';
    }
  }

  [[3.5, 3.5], [n - 3.5, 3.5], [3.5, n - 3.5]].forEach(function(e) {
    var x = e[0] - h;
    var y = e[1] - h;
    o += '<circle cx="' + x + '" cy="' + y + '" r="2.95" fill="none" stroke="' + c + '" stroke-width="1.1"/><circle cx="' + x + '" cy="' + y + '" r="1.6"/>';
  });

  if (fillDots) {
    var f2 = rng(5);
    for (var r = -9; r < n + 9; r++) {
      for (var k = -9; k < n + 9; k++) {
        if (r >= -1 && r <= n && k >= -1 && k <= n) continue;
        var x = k + 0.5 - h;
        var y = r + 0.5 - h;
        if (Math.hypot(x, y) > R0 - 0.2) continue;
        if (f2() < 0.55) {
          o += '<circle cx="' + x + '" cy="' + y + '" r=".47"' + (f2() < 0.2 ? ' fill="#7d7d7d"' : '') + '/>';
        }
      }
    }
  }

  var d = '';
  var P = function(R, a) {
    return (R * Math.cos(a)).toFixed(2) + ' ' + (R * Math.sin(a)).toFixed(2);
  };

  for (var i = 0; i < 3; i++) {
    var R = R0 + 1.3 + i * SP;
    var f = rng(11 + i * 17);
    var a = f() * 6.283;
    var e = a + 6.283 - 0.06;
    while (a < e) {
      var l = Math.min((2.2 + f() * 2.6) / R, e - a);
      var g = f() < 0.3 ? '#7d7d7d' : c;
      d += '<path d="M' + P(R, a) + 'A' + R + ' ' + R + ' 0 0 1 ' + P(R, a + l) + '" stroke="' + g + '" fill="none" stroke-width="' + W + '" stroke-linecap="round"/>';
      a += l + (1.5 + f() * 1.1) / R;
    }
  }

  var lg = '<circle r="' + lr + '" fill="' + c + '"/>';
  if (logoImg) {
    lg += '<clipPath id="cp"><circle r="' + (lr * 0.82) + '"/></clipPath><image href="' + logoImg + '" x="' + (-lr) + '" y="' + (-lr) + '" width="' + (2 * lr) + '" height="' + (2 * lr) + '" preserveAspectRatio="xMidYMid slice" clip-path="url(#cp)"/>';
  } else if (text) {
    var cleanText = String(text).replace(/[<>&]/g, '');
    lg += '<text text-anchor="middle" dominant-baseline="central" fill="#fff" font-family="Figtree,sans-serif" font-weight="' + fontWeight + '" font-size="' + (lr * (cleanText.length > 3 ? 0.55 : 0.7)) + '" font-style="italic">' + cleanText + '</text>';
  }

  var sizeAttrs = isFixedDimensions ? ' width="1024" height="1024"' : '';
  var bgRect = isFixedDimensions ? '<rect x="' + (-H) + '" y="' + (-H) + '" width="' + (2 * H) + '" height="' + (2 * H) + '" fill="#fff"/>' : '';

  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + (-H) + ' ' + (-H) + ' ' + (2 * H) + ' ' + (2 * H) + '"' + sizeAttrs + '>' + bgRect + '<g fill="' + c + '">' + o + '</g>' + d + lg + '</svg>';
}

  </script>

  <!-- Payment Controller Script -->
  <script>
    // State
    const urlParams = new URLSearchParams(window.location.search);
    let amount = ${finalAmount};
    if (isNaN(amount) || amount <= 0) amount = 100;

    let orderId = "${orderId}";
    let ticket = "${ticketParam}";
    let merchantUpi = "${MERCHANT_UPI_ID}";
    let merchantName = "${MERCHANT_NAME}";
    let userId = "${userId}";
    let pollInterval = null;

    function formatCurrency(amt) {
      return '₹' + amt.toFixed(2);
    }

    function generateUpiUri(amt) {
      return 'upi://pay?pa=' + encodeURIComponent(merchantUpi) +
             '&pn=' + encodeURIComponent(merchantName) +
             '&am=' + amt.toFixed(2) +
             '&cu=INR' +
             '&tr=' + encodeURIComponent(orderId);
    }

    function renderCircularQr() {
      const upiUri = generateUpiUri(amount);
      const q = qrcode(0, 'H');
      q.addData(upiUri);
      q.make();

      const n = q.getModuleCount();
      const svgHtml = circ(q, n, '#000000', {
        text: 'UPI',
        fillDots: true,
        fontWeight: '800'
      });

      document.getElementById('qrBox').innerHTML = svgHtml;
      document.getElementById('displayAmount').innerText = formatCurrency(amount);
      document.getElementById('paySubText').innerText = 'Scan QR or pay to ' + merchantName;
    }

    function promptEditAmount() {
      const input = prompt('Enter deposit amount (₹):', amount.toString());
      if (input !== null) {
        const parsed = parseFloat(input.trim());
        if (!isNaN(parsed) && parsed >= 1 && parsed <= 50000) {
          amount = parsed;
          renderCircularQr();
        } else {
          alert('Please enter a valid amount between ₹1 and ₹50,000');
        }
      }
    }

    function openUpiApp(app) {
      const baseUri = generateUpiUri(amount);
      let targetUri = baseUri;
      if (app === 'phonepe') {
        targetUri = baseUri.replace('upi://', 'phonepe://');
      } else if (app === 'gpay') {
        targetUri = baseUri.replace('upi://', 'tez://upi/');
      } else if (app === 'paytm') {
        targetUri = baseUri.replace('upi://', 'paytmmp://');
      } else if (app === 'whatsapp') {
        targetUri = baseUri.replace('upi://', 'whatsapp://');
      }
      window.location.href = targetUri;
    }

    function handleBack() {
      if (window.AndroidBridge && window.AndroidBridge.closeDeposit) {
        window.AndroidBridge.closeDeposit();
      } else if (window.history.length > 1) {
        window.history.back();
      } else {
        window.close();
      }
    }

    function handleReturnToGame() {
      if (window.AndroidBridge && window.AndroidBridge.onDepositSuccess) {
        window.AndroidBridge.onDepositSuccess();
      } else {
        handleBack();
      }
    }

    function showAlert(msg, isError) {
      const el = document.getElementById('statusAlert');
      el.className = 'status-alert ' + (isError ? 'error' : 'success');
      el.innerText = msg;
    }

    async function submitUtr() {
      const utr = document.getElementById('utrInput').value.trim();
      if (!utr || utr.length < 8) {
        showAlert('Please enter valid 12-digit UTR / Ref No.', true);
        return;
      }

      const btn = document.getElementById('submitBtn');
      btn.disabled = true;
      btn.innerHTML = 'Verifying...';

      try {
        const payload = {
          depositId: orderId,
          utr: utr,
          amountRupees: amount,
          userId: userId
        };

        const res = await fetch('/api/v1/deposits/submit-utr', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(ticket ? { 'X-Page-Ticket': ticket } : {})
          },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (data.success) {
          showSuccess();
        } else {
          showAlert(data.message || 'Payment submitted! Verifying in background...', false);
          startPolling();
        }
      } catch (err) {
        showAlert('UTR Submitted! Verification is in progress.', false);
        startPolling();
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>SUBMIT PAYMENT</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>';
      }
    }

    function showSuccess() {
      if (pollInterval) clearInterval(pollInterval);
      document.getElementById('paymentCard').style.display = 'none';
      const succ = document.getElementById('successCard');
      succ.className = 'card-success active';
      document.getElementById('successAmountText').innerText = formatCurrency(amount);
      document.getElementById('successOrderIdText').innerText = 'Order ID: ' + orderId;

      if (window.AndroidBridge && window.AndroidBridge.syncWalletBalance) {
        try {
          window.AndroidBridge.syncWalletBalance(Math.round(amount * 100));
        } catch (_) {}
      }
    }

    function startPolling() {
      if (pollInterval) return;
      pollInterval = setInterval(async () => {
        try {
          const res = await fetch('/api/v1/deposits/' + encodeURIComponent(orderId) + '/status');
          const data = await res.json();
          if (data.success && (data.data?.status === 'COMPLETED' || data.data?.status === 'SUCCESS')) {
            showSuccess();
          }
        } catch (_) {}
      }, 3000);
    }

    // Initialize
    window.addEventListener('DOMContentLoaded', () => {
      renderCircularQr();
    });
  </script>
</body>
</html>`;

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(html);
});
