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
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
      font-family: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif;
      -webkit-tap-highlight-color: transparent;
    }
    html, body {
      width: 100%;
      min-height: 100%;
      background: #FFFFFF;
    }
    body {
      color: #111827;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 0;
      margin: 0;
      position: relative;
      overflow-x: hidden;
    }
    
    .screen-container {
      width: 100%;
      max-width: 480px;
      min-height: 100vh;
      background: #FFFFFF;
      display: flex;
      flex-direction: column;
      position: relative;
    }

    /* Clean White Top Header with Back, Title & 10-Min Timer */
    .top-header {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: relative;
      padding: 16px 18px 14px 18px;
      background: #FFFFFF;
      border-bottom: 1px solid #F1F5F9;
    }
    .back-btn {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      background: #F8FAFC;
      border: 1px solid #E2E8F0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #1E293B;
      cursor: pointer;
      flex-shrink: 0;
      transition: background 0.2s;
    }
    .back-btn:active {
      background: #E2E8F0;
    }
    .header-text {
      flex: 1;
      text-align: center;
      padding: 0 10px;
    }
    .header-title {
      font-size: 19px;
      font-weight: 800;
      color: #0F172A;
      letter-spacing: -0.3px;
    }
    .header-subtitle {
      font-size: 12px;
      color: #64748B;
      margin-top: 1px;
      font-weight: 500;
    }
    .timer-badge {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 6px 11px;
      background: #F8FAFC;
      border: 1.5px solid #E2E8F0;
      border-radius: 20px;
      color: #0F172A;
      font-size: 13px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
      transition: all 0.3s;
    }
    .timer-badge.warning {
      background: #FEF2F2;
      border-color: #FCA5A5;
      color: #DC2626;
      animation: pulse 1s infinite alternate;
    }

    /* Main Full-Width Payment Sheet */
    .card-upi {
      background: #FFFFFF;
      width: 100%;
      flex: 1;
      border-radius: 0;
      padding: 20px 20px 48px 20px;
      color: #111827;
      position: relative;
      box-shadow: none;
      display: flex;
      flex-direction: column;
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
      padding: 12px 16px;
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
      padding: 12px;
      display: flex;
      justify-content: center;
      align-items: center;
      margin-bottom: 20px;
      box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.02);
      width: 100%;
    }
    .qr-container svg {
      width: 100%;
      max-width: 240px;
      height: auto;
      aspect-ratio: 1 / 1;
      display: block;
    }

    .apps-row {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 6px;
      margin-bottom: 20px;
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
      margin-bottom: 18px;
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
      margin-bottom: 16px;
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
      padding: 14px 16px;
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
      padding: 15px;
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

    /* Complete Expired Order Screen */
    .card-expired {
      display: none;
      background: #FFFFFF;
      width: 100%;
      flex: 1;
      border-radius: 0;
      padding: 36px 20px 48px 20px;
      text-align: center;
      animation: popIn 0.35s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .card-expired.active {
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .expired-icon-wrap {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      background: #FEE2E2;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 18px;
    }
    .expired-title {
      font-size: 22px;
      font-weight: 800;
      color: #DC2626;
      margin-bottom: 6px;
    }
    .expired-subtitle {
      font-size: 14px;
      color: #64748B;
      line-height: 1.5;
      margin-bottom: 24px;
      max-width: 320px;
    }
    .expired-info-box {
      width: 100%;
      background: #F8FAFC;
      border: 1px solid #E2E8F0;
      border-radius: 16px;
      padding: 16px;
      margin-bottom: 24px;
      text-align: left;
    }
    .expired-row {
      display: flex;
      justify-content: space-between;
      padding: 6px 0;
      font-size: 13px;
      color: #64748B;
    }
    .expired-val {
      font-weight: 700;
      color: #0F172A;
    }
    .btn-retry {
      width: 100%;
      background: #0F172A;
      color: #FFFFFF;
      border: none;
      border-radius: 14px;
      padding: 15px;
      font-size: 15px;
      font-weight: 800;
      cursor: pointer;
      margin-bottom: 12px;
      transition: background 0.2s;
    }
    .btn-retry:active {
      background: #1E293B;
    }

    /* Beautiful Celebration Success Screen */
    .card-success {
      display: none;
      background: #FFFFFF;
      width: 100%;
      flex: 1;
      border-radius: 0;
      overflow: hidden;
      text-align: center;
      animation: popIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .card-success.active {
      display: flex;
      flex-direction: column;
    }
    .success-hero {
      background: linear-gradient(180deg, #059669 0%, #10B981 100%);
      padding: 40px 20px 28px 20px;
      color: #FFFFFF;
      position: relative;
    }
    .check-wrap {
      width: 76px;
      height: 76px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.22);
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 16px auto;
      box-shadow: 0 0 30px rgba(255, 255, 255, 0.4);
      animation: bounce 0.6s ease;
    }
    .check-inner {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: #FFFFFF;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .check-svg {
      width: 32px;
      height: 32px;
      stroke: #059669;
      stroke-width: 4;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .success-hero h2 {
      font-size: 24px;
      font-weight: 900;
      letter-spacing: -0.3px;
    }
    .success-hero p {
      font-size: 14px;
      opacity: 0.95;
      margin-top: 4px;
    }
    .success-content {
      padding: 24px 20px 48px 20px;
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .receipt-box {
      background: #F8FAFC;
      border: 1.5px solid #E2E8F0;
      border-radius: 18px;
      padding: 20px 16px;
      margin-bottom: 24px;
      text-align: left;
    }
    .receipt-amt-box {
      text-align: center;
      padding-bottom: 16px;
      border-bottom: 1px dashed #CBD5E1;
      margin-bottom: 16px;
    }
    .receipt-label {
      font-size: 13px;
      color: #64748B;
      font-weight: 600;
    }
    .receipt-amount {
      font-size: 34px;
      font-weight: 900;
      color: #0F172A;
      letter-spacing: -0.5px;
      margin-top: 4px;
    }
    .receipt-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
      font-size: 13.5px;
      color: #64748B;
    }
    .receipt-val {
      font-weight: 700;
      color: #0F172A;
    }
    .receipt-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      background: #DCFCE7;
      color: #166534;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 800;
    }
    .btn-return {
      width: 100%;
      background: #0F172A;
      color: #FFFFFF;
      border: none;
      border-radius: 14px;
      padding: 16px;
      font-size: 16px;
      font-weight: 800;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
    }
    @keyframes popIn {
      from { transform: scale(0.95); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }
    @keyframes pulse {
      from { opacity: 0.8; }
      to { opacity: 1; transform: scale(1.02); }
    }
    @keyframes bounce {
      0% { transform: scale(0.3); opacity: 0; }
      60% { transform: scale(1.15); opacity: 1; }
      100% { transform: scale(1); }
    }
  </style>
</head>
<body>

  <div class="screen-container">
    <canvas id="confettiCanvas" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 99; display: none;"></canvas>
    <!-- Top Header Navigation with 10-Min Countdown Timer -->
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
      <!-- Top Right Corner Expiry Timer -->
      <div class="timer-badge" id="timerBadge" title="Order Expiry Countdown">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
        <span id="timerText">10:00</span>
      </div>
    </div>

    <!-- Active Full-Width Payment Sheet -->
    <div class="card-upi" id="paymentCard">
      <div class="bhim-row">
        <span class="bhim-brand">BHIM</span>
        <span class="upi-pill">UPI</span>
      </div>
      <h2 class="pay-title">PAY VIA UPI</h2>
      <p class="pay-sub" id="paySubText">Scan QR or pay to satyam</p>

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

      <div class="qr-container" id="qrBox"></div>

      <div class="apps-row">
        <div class="app-item" onclick="openUpiApp('phonepe')">
          <div class="app-icon"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAACgBAMAAAB54XoeAAAAAXNSR0IArs4c6QAAACFQTFRFR3BMXyWfXySfXiOfXiSfXyWf////eUmvxK7cpIPI5dvwZL2jYAAAAAV0Uk5TAM9qJJimOUzHAAAEEUlEQVRo3t1bTVMaQRBFV+8ocl9NuG9MecdUeXfYHRfyAzbEO5hwdyvhDjHes378yiyluARmul8PY0ilb1rW8w39OT2PWo2146PTvabWau/g6E1tbXv/tsSqTH2I1oLbPtUrduBOMzjURtt3ZHnc1BZTTiQPNWH78uO2NGkHwmMHZ5qxRIQYNLX2igjgiRDPtPaKeKhBA339TsPWgNJNCyz04+CFnOE/xpYWGfsx7mihtX0eGDj0iRZbw5uHEU+3XAA7nglSFE05/LXI7gdMTgtCJh1npfUdQ2flE0xvsie7c6K4SnD4jMdSDEEX53PA7NrB0QYXT7N1KBqSpPcCmE1owBjM4oriJ3FGb5n+boEiE4t1sDFVFKWRY8m69AXwUugWW2eaopETg609RSNHoXVmhEZOCFbqtJgDfpacmWglIzByFFpZK4p3+JnJ6WMERk4dHbcqir/Q2A7ofz0CIyeCx4UCi5w23N4/YpET4xNrDlFU4EdY2hcsciJ84sqh4G7jE1IXipxYMPTnSHB3BLeSHlQWJSNSjkROaG9PdooTNp3BqXUKNNTYMoKk3ww2nlN8+nFi90rTPiQRdjmw5UpAtTrC7my5su0I2Le5ecsRMLO5+cQV0PQhnpuvEu6AHXMmuwMm5kx2B5zFjeHXFxDgxFweAnrOFDIsA3GbLNBUqljqjbH+p+PHx8fCivVzZj8sXWCLLS+DlVmRLGC7fgHPiWo4XfYmAhgTd24nhh0AcOIbUMjwzC9gQjRlpyMrAHCwYUDt+8jaL0Ptm6HeBMP/7sgbCOx/P/WEDAXlS0Ply3PFTjbRAq4lR+4AbfRa1kbtjX64cl+EGr19FLlYvulgo8gOuxjoSxi2iatjd3kQRBiGxH6gt3LFAQCjGlG/XkbLydJ/oG/MTX5dczkbLq9uMx5QkQuChctAOdAyd6jqWtHi9z/Ipay6+OzyXsEBY3pDUIgB6/QOYygGDOlFVVcMGDFrm0IIqLinspEQsMOtWdJCBhizi6CuDLDOr6puRYDPm2dyoTReuH9ygAp6wJw/xWUPVxxggi0k05vysnv/fcAX2Fj6SM0BtuGlLtgCIpHwggdMxO/eDGBMP8HJGS484vphGEnVJgzDhHt2lDJsiB/nGYahWLFDM1RywQTNMHYQJJCAoVylRDJULiIRCrDhIsLICcDQRUk1tAMm2JO6Zdixtqc/Hv3xMxt2myYZD+KWNLe8AsTO2pi0NMQlzuqdxRFkbUEVQxDW4CExsybFtlcNFCExcqUY/j2Zln8hmUTMSCXJK4rxvMsFBYpQ3iOvJLn0Lgr1L1v1L6wFpM5cDrshSuTOCKIS4PkXeJeIp0xAy5X3nkXyryDj9/9FgxlJ01chwto6Fvj9sobD10l+A1ELni9dtAl8AAAAAElFTkSuQmCC" alt="PhonePe"></div>
          <span class="app-name">PhonePe</span>
        </div>
        <div class="app-item" onclick="openUpiApp('gpay')">
          <div class="app-icon"><img src="data:image/png;base64,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" alt="Google Pay"></div>
          <span class="app-name">Google Pay</span>
        </div>
        <div class="app-item" onclick="openUpiApp('paytm')">
          <div class="app-icon"><img src="data:image/png;base64,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" alt="Paytm"></div>
          <span class="app-name">Paytm</span>
        </div>
        <div class="app-item" onclick="openUpiApp('whatsapp')">
          <div class="app-icon" style="background: #25D366;">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91C2.13 13.66 2.59 15.36 3.45 16.86L2.05 22L7.3 20.62C8.75 21.41 10.38 21.83 12.04 21.83C17.5 21.83 21.95 17.38 21.95 11.92C21.95 9.27 20.92 6.78 19.05 4.91C17.18 3.03 14.69 2 12.04 2ZM12.04 20.15C10.56 20.15 9.11 19.76 7.85 19.01L7.55 18.83L4.43 19.65L5.26 16.61L5.06 16.29C4.24 14.99 3.8 13.47 3.8 11.91C3.8 7.37 7.5 3.67 12.05 3.67C14.25 3.67 16.31 4.53 17.87 6.09C19.42 7.65 20.28 9.72 20.28 11.92C20.28 16.46 16.58 20.15 12.04 20.15ZM16.57 14.36C16.32 14.23 15.1 13.63 14.88 13.55C14.65 13.47 14.48 13.43 14.32 13.68C14.15 13.93 13.67 14.49 13.52 14.66C13.38 14.83 13.23 14.85 12.98 14.73C12.73 14.6 11.93 14.34 10.98 13.49C10.24 12.83 9.74 12.02 9.6 11.77C9.45 11.52 9.58 11.38 9.71 11.26C9.82 11.15 9.96 10.97 10.08 10.82C10.21 10.67 10.25 10.57 10.33 10.4C10.42 10.23 10.37 10.09 10.31 9.96C10.25 9.84 9.75 8.61 9.54 8.11C9.34 7.62 9.14 7.69 8.98 7.68C8.84 7.67 8.67 7.67 8.5 7.67C8.33 7.67 8.06 7.73 7.83 7.98C7.6 8.23 6.96 8.83 6.96 10.04C6.96 11.25 7.85 12.42 7.97 12.59C8.1 12.76 9.71 15.24 12.18 16.3C12.77 16.55 13.23 16.71 13.58 16.82C14.18 17.01 14.72 16.98 15.15 16.92C15.63 16.85 16.63 16.31 16.84 15.73C17.05 15.15 17.05 14.66 16.98 14.53C16.92 14.41 16.82 14.48 16.57 14.36Z" fill="white"/></svg>
          </div>
          <span class="app-name">WhatsApp</span>
        </div>
        <div class="app-item" onclick="openUpiApp('any')">
          <div class="app-icon"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAABQCAMAAAC5zwKfAAABKVBMVEXm5ubn5+fk5OTn5+fm5ubk5OTn5+fm5ubl5eXm5ubm5ubn5+fl5eXm5ubo6Ojn5+fm5ubl5eXm5ubf39/m5uYAAAD73sj97+To6Ojyi0HS6t3S6tyAlFIclFObgTL73smagTL7+/tYsYE6omv19fW3fy7zk06FxqPu7u7Ffiz5+fn4xJ9FiD+pgDD85tX09PTyikBwhDnFfSz1rHcrm1/73cn+9/Eqm1/0m1yz28Znt4zs7OwblFPxgjN+hDZYsIHz8/PC49Hr6+sMjUjh8ej5za3ieyf8/PxJqXb6+vqj1Lr61rvv7+/Kp3D97uP85tbyi0DweiX1o2kai0ak1Lrw+PT39/fx8fHn5+cpi0T29vYajEb2tIR2v5jp6en9/f3m5ub////y8vIQFjv7AAAAFnRSTlOgIGCfr5BgcIDvUEDPv29/j5/fEM8AfMCZ1gAAA/FJREFUWMO9mVt700YQhleOT7ItYmltCNDS0rpJMAWFQ9wQJYWgpCIlTREljhtAms3//xHswSSWY+2s7MDc6EZ6n29ndmdnRqSrN9qouY7nATe75bj1JkU+IFpYW5Ky5rkNOhewWbb556Pg9GwYRYxbetj3T4ORgLqNokC6LGiB32dX7NAPhM6SVQAoccmrlOVYdJZw5LIxsMo9F/SZ1oaBUGkEtBwcJ6zPVZYtHHjDhpHPjIwv3C4hQNoGWE+ZoUVHAG0t0GoZy1Pmj6Bl5QMtD5KIFbIoAc/KA3Le64I8TnydJZIsL2WFLc0SyaK8aeIlsDUnTxJb9AqwXTgemci0p4FVGM3N48QR1LJAywafLWA+2FYGWIYjtpCtgzMJrC7gwHFgRlCaAHpwZvLViXbRHr0ALkOiBR2vysf+G91LAdS/AvmW1ue/g/hAPD6Ee7r8CDYdA6sQ6Jf6Pn4nHi9DA4lEenCoB+7GUuJOiElUwAbiQbYZx0LiXhjqJSbQlMAlLMSfOJBL3OZArcRzKAsgBUD24JYAvhv8ESISUxEWwleMhGQQS/snDDGJATQ4cAk7xW8V8K//QkyiDxUO9OC+HvhMAeMnqMQ+eF1CYQU5cBtj4NMQlTgCSpqYCx/HX+13VCJ3IqnDqR748AL4GyrxFGqEYDHZis0l9sAlDpIY2CUPlzgEh3SQIG9OAFGJEXjEhhQ/d1MSf9UBAfQrXo1nSPyQ9zYABjzO8OJHCvjL/MCDLPBnBfw8P/B9hvfgf+XDfQ3Q0yevjUxMPkre9okmgSHAx5O8e2q92/mvH0KHb+yh0bm74K1prxWHH72e2bn7E+fxhOiSmi45DIrxeHKoE+0N8LYYj6evpj7BPpvi/Y3kYpFgu7o6ZKMY71BcAd1KfkI8zvB+fIGXna7+Gh2fux8U7y5a7qlrlOYnMHXuDnYMeRGAuOh5OXyeXyTFuz/dEbzn+3g9yi8AWds084olkax3/2UvDHm8WGqocs7OiTM/d7dvMbZmyBvyGCtgPScsW5LH3pjxeEhKYyCdLXGgeGzHjNdXHZ8s2mdL3FwdiMeeGY978KJo71Jv1ua+KXns7okRryc9eNn4rMzZiU70j5ONT9eB9cWAR6Ic/pbNY7cGK4u1t6XpBryyWANeudLR085CI4LvMcS49jHL9Q+Crn9UxYkdWLnOYZrcPXBkLDJdB6hQZCBZtSHpGcuzawYj0zJAYjIyDQAcy3yoO8RxhkNdmXE5Munl+jI9TwDsOi0wGLeESgj8GT1MXw7Gc3C60X2DgBrd+/378gBF0fBMje7tcnPOnwtk1s+Fypw/F8bQZt11OrYkeY5ba2C/P74A6SVY81U6htQAAAAASUVORK5CYII=" alt="Any UPI"></div>
          <span class="app-name">Any UPI</span>
        </div>
      </div>

      <div class="divider-row">
        <div class="divider-line"></div>
        <span class="divider-text">OR</span>
        <div class="divider-line"></div>
      </div>

      <div class="utr-section">
        <label class="utr-label" for="utrInput">ENTER 12-DIGIT UTR / REF NO.</label>
        <input type="text" class="utr-input" id="utrInput" placeholder="e.g. 426819203814" maxlength="16" autocomplete="off" autocorrect="off">
        <div class="status-alert" id="statusAlert"></div>
        <button class="btn-submit" id="submitBtn" onclick="submitUtr()">
          <span>SUBMIT PAYMENT</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
        </button>
      </div>

      <p class="verify-note">Payment will be credited automatically after verification</p>
    </div>

    <!-- 10-Minute Expired Order View (Complete Page Replacement) -->
    <div class="card-expired" id="expiredCard">
      <div class="expired-icon-wrap">
        <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="#DC2626" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
      </div>
      <h2 class="expired-title">Deposit Order Expired</h2>
      <p class="expired-subtitle">This payment session has timed out after 10 minutes. For security reasons, please do not pay on this QR.</p>
      
      <div class="expired-info-box">
        <div class="expired-row"><span>Order ID</span><span class="expired-val" id="expOrderId">DEP-0000</span></div>
        <div class="expired-row"><span>Amount</span><span class="expired-val" id="expAmount">₹${finalAmount.toFixed(2)}</span></div>
        <div class="expired-row"><span>Session Status</span><span style="color: #DC2626; font-weight: 800;">EXPIRED</span></div>
      </div>

      <button class="btn-retry" onclick="restartDepositOrder()">CREATE NEW DEPOSIT ORDER</button>
      <button class="btn-retry" style="background: #F1F5F9; color: #475569; border: 1px solid #CBD5E1;" onclick="handleBack()">CANCEL & RETURN</button>
    </div>

    <!-- Celebration Success Screen (Appears immediately when Admin approves) -->
    <div class="card-success" id="successCard">
      <div class="success-hero">
        <div class="check-wrap">
          <div class="check-inner">
            <svg class="check-svg" viewBox="0 0 24 24">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>
        </div>
        <h2>Deposit Approved!</h2>
        <p>Funds successfully credited to your wallet</p>
      </div>
      <div class="success-content">
        <div class="receipt-box">
          <div class="receipt-amt-box">
            <div class="receipt-label">Amount Credited</div>
            <div class="receipt-amount" id="successAmountText">₹${finalAmount.toFixed(2)}</div>
            <div style="margin-top: 6px;"><span class="receipt-badge">✓ Verified & Approved</span></div>
          </div>
          <div class="receipt-row"><span>Order ID</span><span class="receipt-val" id="successOrderIdText">DEP-000</span></div>
          <div class="receipt-row"><span>Payment Mode</span><span class="receipt-val">UPI Instant Deposit</span></div>
          <div class="receipt-row"><span>Status</span><span class="receipt-val" style="color: #059669;">COMPLETED</span></div>
          <div class="receipt-row"><span>Updated At</span><span class="receipt-val" id="successTimeText">Just now</span></div>
        </div>
        <button class="btn-return" onclick="handleReturnToGame()">
          <span>RETURN TO GAME</span>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
        </button>
      </div>
    </div>
  </div>

  <script>
var qrcode=function(){function i(t,r){function a(t,r){g=function(t){for(var r=new Array(t),e=0;e<t;e+=1){r[e]=new Array(t);for(var n=0;n<t;n+=1)r[e][n]=null}return r}(l=4*u+17),e(0,0),e(l-7,0),e(0,l-7),i(),o(),v(t,r),7<=u&&h(t),null==n&&(n=w(u,f,c)),d(n,r)}var u=t,f=y[r],g=null,l=0,n=null,c=[],s={},e=function(t,r){for(var e=-1;e<=7;e+=1)if(!(t+e<=-1||l<=t+e))for(var n=-1;n<=7;n+=1)r+n<=-1||l<=r+n||(g[t+e][r+n]=0<=e&&e<=6&&(0==n||6==n)||0<=n&&n<=6&&(0==e||6==e)||2<=e&&e<=4&&2<=n&&n<=4)},o=function(){for(var t=8;t<l-8;t+=1)null==g[t][6]&&(g[t][6]=t%2==0);for(var r=8;r<l-8;r+=1)null==g[6][r]&&(g[6][r]=r%2==0)},i=function(){for(var t=B.getPatternPosition(u),r=0;r<t.length;r+=1)for(var e=0;e<t.length;e+=1){var n=t[r],o=t[e];if(null==g[n][o])for(var i=-2;i<=2;i+=1)for(var a=-2;a<=2;a+=1)g[n+i][o+a]=-2==i||2==i||-2==a||2==a||0==i&&0==a}},h=function(t){for(var r=B.getBCHTypeNumber(u),e=0;e<18;e+=1){var n=!t&&1==(r>>e&1);g[Math.floor(e/3)][e%3+l-8-3]=n}for(e=0;e<18;e+=1){n=!t&&1==(r>>e&1);g[e%3+l-8-3][Math.floor(e/3)]=n}},v=function(t,r){for(var e=f<<3|r,n=B.getBCHTypeInfo(e),o=0;o<15;o+=1){var i=!t&&1==(n>>o&1);o<6?g[o][8]=i:o<8?g[o+1][8]=i:g[l-15+o][8]=i}for(o=0;o<15;o+=1){i=!t&&1==(n>>o&1);o<8?g[8][l-o-1]=i:o<9?g[8][15-o-1+1]=i:g[8][15-o-1]=i}g[l-8][8]=!t},d=function(t,r){for(var e=-1,n=l-1,o=7,i=0,a=B.getMaskFunction(r),u=l-1;0<u;u-=2)for(6==u&&(u-=1);;){for(var f=0;f<2;f+=1)if(null==g[n][u-f]){var c=!1;i<t.length&&(c=1==(t[i]>>>o&1)),a(n,u-f)&&(c=!c),g[n][u-f]=c,-1==(o-=1)&&(i+=1,o=7)}if((n+=e)<0||l<=n){n-=e,e=-e;break}}},w=function(t,r,e){for(var n=b.getRSBlocks(t,r),o=M(),i=0;i<e.length;i+=1){var a=e[i];o.put(a.getMode(),4),o.put(a.getLength(),B.getLengthInBits(a.getMode(),t)),a.write(o)}var u=0;for(i=0;i<n.length;i+=1)u+=n[i].dataCount;if(o.getLengthInBits()>8*u)throw"code length overflow. ("+o.getLengthInBits()+">"+8*u+")";for(o.getLengthInBits()+4<=8*u&&o.put(0,4);o.getLengthInBits()%8!=0;)o.putBit(!1);for(;!(o.getLengthInBits()>=8*u||(o.put(236,8),o.getLengthInBits()>=8*u));)o.put(17,8);return function(t,r){for(var e=0,n=0,o=0,i=new Array(r.length),a=new Array(r.length),u=0;u<r.length;u+=1){var f=r[u].dataCount,c=r[u].totalCount-f;n=Math.max(n,f),o=Math.max(o,c),i[u]=new Array(f);for(var g=0;g<i[u].length;g+=1)i[u][g]=255&t.getBuffer()[g+e];e+=f;var l=B.getErrorCorrectPolynomial(c),h=C(i[u],l.getLength()-1).mod(l);a[u]=new Array(l.getLength()-1);for(g=0;g<a[u].length;g+=1){var s=g+h.getLength()-a[u].length;a[u][g]=0<=s?h.getAt(s):0}}var v=0;for(g=0;g<r.length;g+=1)v+=r[g].totalCount;var d=new Array(v),w=0;for(g=0;g<n;g+=1)for(u=0;u<r.length;u+=1)g<i[u].length&&(d[w]=i[u][g],w+=1);for(g=0;g<o;g+=1)for(u=0;u<r.length;u+=1)g<a[u].length&&(d[w]=a[u][g],w+=1);return d}(o,n)};s.addData=function(t,r){var e=null;switch(r=r||"Byte"){case"Numeric":e=x(t);break;case"Alphanumeric":e=m(t);break;case"Byte":e=L(t);break;case"Kanji":e=D(t);break;default:throw"mode:"+r}c.push(e),n=null},s.isDark=function(t,r){if(t<0||l<=t||r<0||l<=r)throw t+","+r;return g[t][r]},s.getModuleCount=function(){return l},s.make=function(){if(u<1){for(var t=1;t<40;t++){for(var r=b.getRSBlocks(t,f),e=M(),n=0;n<c.length;n++){var o=c[n];e.put(o.getMode(),4),e.put(o.getLength(),B.getLengthInBits(o.getMode(),t)),o.write(e)}var i=0;for(n=0;n<r.length;n++)i+=r[n].dataCount;if(e.getLengthInBits()<=8*i)break}u=t}a(!1,function(){for(var t=0,r=0,e=0;e<8;e+=1){a(!0,e);var n=B.getLostPoint(s);(0==e||n<t)&&(t=n,r=e)}return r}())},s.createTableTag=function(t,r){t=t||2;var e="";e+='<table style="',e+=" border-width: 0px; border-style: none;",e+=" border-collapse: collapse;",e+=" padding: 0px; margin: "+(r=void 0===r?4*t:r)+"px;",e+='">',e+="<tbody>";for(var n=0;n<s.getModuleCount();n+=1){e+="<tr>";for(var o=0;o<s.getModuleCount();o+=1)e+='<td style="',e+=" border-width: 0px; border-style: none;",e+=" border-collapse: collapse;",e+=" padding: 0px; margin: 0px;",e+=" width: "+t+"px;",e+=" height: "+t+"px;",e+=" background-color: ",e+=s.isDark(n,o)?"#000000":"#ffffff",e+=";",e+='"/>';e+="</tr>"}return e+="</tbody>",e+="</table>"},s.createSvgTag=function(t,r,e,n){var o={};"object"==typeof t&&(t=(o=t).cellSize,r=o.margin,e=o.alt,n=o.title),t=t||2,r=void 0===r?4*t:r,(e="string"==typeof e?{text:e}:e||{}).text=e.text||null,e.id=e.text?e.id||"qrcode-description":null,(n="string"==typeof n?{text:n}:n||{}).text=n.text||null,n.id=n.text?n.id||"qrcode-title":null;var i,a,u,f,c=s.getModuleCount()*t+2*r,g="";for(f="l"+t+",0 0,"+t+" -"+t+",0 0,-"+t+"z ",g+='<svg version="1.1" xmlns="http://www.w3.org/2000/svg"',g+=o.scalable?"":' width="'+c+'px" height="'+c+'px"',g+=' viewBox="0 0 '+c+" "+c+'" ',g+=' preserveAspectRatio="xMinYMin meet"',g+=n.text||e.text?' role="img" aria-labelledby="'+p([n.id,e.id].join(" ").trim())+'"':"",g+=">",g+=n.text?'<title id="'+p(n.id)+'">'+p(n.text)+"</title>":"",g+=e.text?'<description id="'+p(e.id)+'">'+p(e.text)+"</description>":"",g+='<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>',g+='<path d="',a=0;a<s.getModuleCount();a+=1)for(u=a*t+r,i=0;i<s.getModuleCount();i+=1)s.isDark(a,i)&&(g+="M"+(i*t+r)+","+u+f);return g+='" stroke="transparent" fill="black"/>',g+="</svg>"},s.createDataURL=function(o,t){o=o||2,t=void 0===t?4*o:t;var r=s.getModuleCount()*o+2*t,i=t,a=r-t;return I(r,r,function(t,r){if(i<=t&&t<a&&i<=r&&r<a){var e=Math.floor((t-i)/o),n=Math.floor((r-i)/o);return s.isDark(n,e)?0:1}return 1})},s.createImgTag=function(t,r,e){t=t||2,r=void 0===r?4*t:r;var n=s.getModuleCount()*t+2*r,o="";return o+="<img",o+=' src="',o+=s.createDataURL(t,r),o+='"',o+=' width="',o+=n,o+='"',o+=' height="',o+=n,o+='"',e&&(o+=' alt="',o+=p(e),o+='"'),o+="/>"};var p=function(t){for(var r="",e=0;e<t.length;e+=1){var n=t.charAt(e);switch(n){case"<":r+="&lt;";break;case">":r+="&gt;";break;case"&":r+="&amp;";break;case'"':r+="&quot;";break;default:r+=n}}return r};return s.createASCII=function(t,r){if((t=t||1)<2)return function(t){t=void 0===t?2:t;var r,e,n,o,i,a=1*s.getModuleCount()+2*t,u=t,f=a-t,c={"██":"█","█ ":"▀"," █":"▄","  ":" "},g={"██":"▀","█ ":"▀"," █":" ","  ":" "},l="";for(r=0;r<a;r+=2){for(n=Math.floor((r-u)/1),o=Math.floor((r+1-u)/1),e=0;e<a;e+=1)i="█",u<=e&&e<f&&u<=r&&r<f&&s.isDark(n,Math.floor((e-u)/1))&&(i=" "),u<=e&&e<f&&u<=r+1&&r+1<f&&s.isDark(o,Math.floor((e-u)/1))?i+=" ":i+="█",l+=t<1&&f<=r+1?g[i]:c[i];l+="\\n"}return a%2&&0<t?l.substring(0,l.length-a-1)+Array(1+a).join("▀"):l.substring(0,l.length-1)}(r);t-=1,r=void 0===r?2*t:r;var e,n,o,i,a=s.getModuleCount()*t+2*r,u=r,f=a-r,c=Array(t+1).join("██"),g=Array(t+1).join("  "),l="",h="";for(e=0;e<a;e+=1){for(o=Math.floor((e-u)/t),h="",n=0;n<a;n+=1)i=1,u<=n&&n<f&&u<=e&&e<f&&s.isDark(o,Math.floor((n-u)/t))&&(i=0),h+=i?c:g;for(o=0;o<t;o+=1)l+=h+"\\n"}return l.substring(0,l.length-1)},s.renderTo2dContext=function(t,r){r=r||2;for(var e=s.getModuleCount(),n=0;n<e;n++)for(var o=0;o<e;o++)t.fillStyle=s.isDark(n,o)?"black":"white",t.fillRect(n*r,o*r,r,r)},s}i.stringToBytes=(i.stringToBytesFuncs={default:function(t){for(var r=[],e=0;e<t.length;e+=1){var n=t.charCodeAt(e);r.push(255&n)}return r}}).default,i.createStringToBytes=function(u,f){var i=function(){function t(){var t=r.read();if(-1==t)throw"eof";return t}for(var r=S(u),e=0,n={};;){var o=r.read();if(-1==o)break;var i=t(),a=t()<<8|t();n[String.fromCharCode(o<<8|i)]=a,e+=1}if(e!=f)throw e+" != "+f;return n}(),a="?".charCodeAt(0);return function(t){for(var r=[],e=0;e<t.length;e+=1){var n=t.charCodeAt(e);if(n<128)r.push(n);else{var o=i[t.charAt(e)];"number"==typeof o?(255&o)==o?r.push(o):(r.push(o>>>8),r.push(255&o)):r.push(a)}}return r}};var r,t,a=1,u=2,o=4,f=8,y={L:1,M:0,Q:3,H:2},e=0,n=1,c=2,g=3,l=4,h=5,s=6,v=7,B=(r=[[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]],(t={}).getBCHTypeInfo=function(t){for(var r=t<<10;0<=d(r)-d(1335);)r^=1335<<d(r)-d(1335);return 21522^(t<<10|r)},t.getBCHTypeNumber=function(t){for(var r=t<<12;0<=d(r)-d(7973);)r^=7973<<d(r)-d(7973);return t<<12|r},t.getPatternPosition=function(t){return r[t-1]},t.getMaskFunction=function(t){switch(t){case e:return function(t,r){return(t+r)%2==0};case n:return function(t,r){return t%2==0};case c:return function(t,r){return r%3==0};case g:return function(t,r){return(t+r)%3==0};case l:return function(t,r){return(Math.floor(t/2)+Math.floor(r/3))%2==0};case h:return function(t,r){return t*r%2+t*r%3==0};case s:return function(t,r){return(t*r%2+t*r%3)%2==0};case v:return function(t,r){return(t*r%3+(t+r)%2)%2==0};default:throw"bad maskPattern:"+t}},t.getErrorCorrectPolynomial=function(t){for(var r=C([1],0),e=0;e<t;e+=1)r=r.multiply(C([1,w.gexp(e)],0));return r},t.getLengthInBits=function(t,r){if(1<=r&&r<10)switch(t){case a:return 10;case u:return 9;case o:case f:return 8;default:throw"mode:"+t}else if(r<27)switch(t){case a:return 12;case u:return 11;case o:return 16;case f:return 10;default:throw"mode:"+t}else{if(!(r<41))throw"type:"+r;switch(t){case a:return 14;case u:return 13;case o:return 16;case f:return 12;default:throw"mode:"+t}}},t.getLostPoint=function(t){for(var r=t.getModuleCount(),e=0,n=0;n<r;n+=1)for(var o=0;o<r;o+=1){for(var i=0,a=t.isDark(n,o),u=-1;u<=1;u+=1)if(!(n+u<0||r<=n+u))for(var f=-1;f<=1;f+=1)o+f<0||r<=o+f||0==u&&0==f||a==t.isDark(n+u,o+f)&&(i+=1);5<i&&(e+=3+i-5)}for(n=0;n<r-1;n+=1)for(o=0;o<r-1;o+=1){var c=0;t.isDark(n,o)&&(c+=1),t.isDark(n+1,o)&&(c+=1),t.isDark(n,o+1)&&(c+=1),t.isDark(n+1,o+1)&&(c+=1),0!=c&&4!=c||(e+=3)}for(n=0;n<r;n+=1)for(o=0;o<r-6;o+=1)t.isDark(n,o)&&!t.isDark(n,o+1)&&t.isDark(n,o+2)&&t.isDark(n,o+3)&&t.isDark(n,o+4)&&!t.isDark(n,o+5)&&t.isDark(n,o+6)&&(e+=40);for(o=0;o<r;o+=1)for(n=0;n<r-6;n+=1)t.isDark(n,o)&&!t.isDark(n+1,o)&&t.isDark(n+2,o)&&t.isDark(n+3,o)&&t.isDark(n+4,o)&&!t.isDark(n+5,o)&&t.isDark(n+6,o)&&(e+=40);var g=0;for(o=0;o<r;o+=1)for(n=0;n<r;n+=1)t.isDark(n,o)&&(g+=1);return e+=Math.abs(100*g/r/r-50)/5*10},t);function d(t){for(var r=0;0!=t;)r+=1,t>>>=1;return r}var w=function(){for(var r=new Array(256),e=new Array(256),t=0;t<8;t+=1)r[t]=1<<t;for(t=8;t<256;t+=1)r[t]=r[t-4]^r[t-5]^r[t-6]^r[t-8];for(t=0;t<255;t+=1)e[r[t]]=t;var n={glog:function(t){if(t<1)throw"glog("+t+")";return e[t]},gexp:function(t){for(;t<0;)t+=255;for(;256<=t;)t-=255;return r[t]}};return n}();function C(n,o){if(void 0===n.length)throw n.length+"/"+o;var r=function(){for(var t=0;t<n.length&&0==n[t];)t+=1;for(var r=new Array(n.length-t+o),e=0;e<n.length-t;e+=1)r[e]=n[e+t];return r}(),i={getAt:function(t){return r[t]},getLength:function(){return r.length},multiply:function(t){for(var r=new Array(i.getLength()+t.getLength()-1),e=0;e<i.getLength();e+=1)for(var n=0;n<t.getLength();n+=1)r[e+n]^=w.gexp(w.glog(i.getAt(e))+w.glog(t.getAt(n)));return C(r,0)},mod:function(t){if(i.getLength()-t.getLength()<0)return i;for(var r=w.glog(i.getAt(0))-w.glog(t.getAt(0)),e=new Array(i.getLength()),n=0;n<i.getLength();n+=1)e[n]=i.getAt(n);for(n=0;n<t.getLength();n+=1)e[n]^=w.gexp(w.glog(t.getAt(n))+r);return C(e,0).mod(t)}};return i}function p(){var e=[],o={writeByte:function(t){e.push(255&t)},writeShort:function(t){o.writeByte(t),o.writeByte(t>>>8)},writeBytes:function(t,r,e){r=r||0,e=e||t.length;for(var n=0;n<e;n+=1)o.writeByte(t[n+r])},writeString:function(t){for(var r=0;r<t.length;r+=1)o.writeByte(t.charCodeAt(r))},toByteArray:function(){return e},toString:function(){var t="";t+="[";for(var r=0;r<e.length;r+=1)0<r&&(t+=","),t+=e[r];return t+="]"}};return o}var k,A,b=(k=[[1,26,19],[1,26,16],[1,26,13],[1,26,9],[1,44,34],[1,44,28],[1,44,22],[1,44,16],[1,70,55],[1,70,44],[2,35,17],[2,35,13],[1,100,80],[2,50,32],[2,50,24],[4,25,9],[1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],[2,86,68],[4,43,27],[4,43,19],[4,43,15],[2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],[2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],[4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],[4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],[3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],[5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],[5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],[1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],[5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],[3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],[3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],[4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],[2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],[4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],[6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],[8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],[10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],[8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],[3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],[7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],[5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],[13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],[17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],[17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],[13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],[12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],[6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],[17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],[4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],[20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],[19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]],(A={}).getRSBlocks=function(t,r){var e=function(t,r){switch(r){case y.L:return k[4*(t-1)+0];case y.M:return k[4*(t-1)+1];case y.Q:return k[4*(t-1)+2];case y.H:return k[4*(t-1)+3];default:return}}(t,r);if(void 0===e)throw"bad rs block @ typeNumber:"+t+"/errorCorrectionLevel:"+r;for(var n,o,i=e.length/3,a=[],u=0;u<i;u+=1)for(var f=e[3*u+0],c=e[3*u+1],g=e[3*u+2],l=0;l<f;l+=1)a.push((n=g,o=void 0,(o={}).totalCount=c,o.dataCount=n,o));return a},A),M=function(){var e=[],n=0,o={getBuffer:function(){return e},getAt:function(t){var r=Math.floor(t/8);return 1==(e[r]>>>7-t%8&1)},put:function(t,r){for(var e=0;e<r;e+=1)o.putBit(1==(t>>>r-e-1&1))},getLengthInBits:function(){return n},putBit:function(t){var r=Math.floor(n/8);e.length<=r&&e.push(0),t&&(e[r]|=128>>>n%8),n+=1}};return o},x=function(t){var r=a,n=t,e={getMode:function(){return r},getLength:function(t){return n.length},write:function(t){for(var r=n,e=0;e+2<r.length;)t.put(o(r.substring(e,e+3)),10),e+=3;e<r.length&&(r.length-e==1?t.put(o(r.substring(e,e+1)),4):r.length-e==2&&t.put(o(r.substring(e,e+2)),7))}},o=function(t){for(var r=0,e=0;e<t.length;e+=1)r=10*r+i(t.charAt(e));return r},i=function(t){if("0"<=t&&t<="9")return t.charCodeAt(0)-"0".charCodeAt(0);throw"illegal char :"+t};return e},m=function(t){var r=u,n=t,e={getMode:function(){return r},getLength:function(t){return n.length},write:function(t){for(var r=n,e=0;e+1<r.length;)t.put(45*o(r.charAt(e))+o(r.charAt(e+1)),11),e+=2;e<r.length&&t.put(o(r.charAt(e)),6)}},o=function(t){if("0"<=t&&t<="9")return t.charCodeAt(0)-"0".charCodeAt(0);if("A"<=t&&t<="Z")return t.charCodeAt(0)-"A".charCodeAt(0)+10;switch(t){case" ":return 36;case"$":return 37;case"%":return 38;case"*":return 39;case"+":return 40;case"-":return 41;case".":return 42;case"/":return 43;case":":return 44;default:throw"illegal char :"+t}};return e},L=function(t){var r=o,e=i.stringToBytes(t),n={getMode:function(){return r},getLength:function(t){return e.length},write:function(t){for(var r=0;r<e.length;r+=1)t.put(e[r],8)}};return n},D=function(t){var r=f,e=i.stringToBytesFuncs.SJIS;if(!e)throw"sjis not supported.";!function(){var t=e("友");if(2!=t.length||38726!=(t[0]<<8|t[1]))throw"sjis not supported."}();var o=e(t),n={getMode:function(){return r},getLength:function(t){return~~(o.length/2)},write:function(t){for(var r=o,e=0;e+1<r.length;){var n=(255&r[e])<<8|255&r[e+1];if(33088<=n&&n<=40956)n-=33088;else{if(!(57408<=n&&n<=60351))throw"illegal char at "+(e+1)+"/"+n;n-=49472}n=192*(n>>>8&255)+(255&n),t.put(n,13),e+=2}if(e<r.length)throw"illegal char at "+(e+1)}};return n},S=function(t){var e=t,n=0,o=0,i=0,r={read:function(){for(;i<8;){if(n>=e.length){if(0==i)return-1;throw"unexpected end of file./"+i}var t=e.charAt(n);if(n+=1,"="==t)return i=0,-1;t.match(/^\\s$/)||(o=o<<6|a(t.charCodeAt(0)),i+=6)}var r=o>>>i-8&255;return i-=8,r}},a=function(t){if(65<=t&&t<=90)return t-65;if(97<=t&&t<=122)return t-97+26;if(48<=t&&t<=57)return t-48+52;if(43==t)return 62;if(47==t)return 63;throw"c:"+t};return r},I=function(t,r,e){for(var n=function(t,r){var n=t,o=r,l=new Array(t*r),e={setPixel:function(t,r,e){l[r*n+t]=e},write:function(t){t.writeString("GIF87a"),t.writeShort(n),t.writeShort(o),t.writeByte(128),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(255),t.writeByte(255),t.writeByte(255),t.writeString(","),t.writeShort(0),t.writeShort(0),t.writeShort(n),t.writeShort(o),t.writeByte(0);var r=i(2);t.writeByte(2);for(var e=0;255<r.length-e;)t.writeByte(255),t.writeBytes(r,e,255),e+=255;t.writeByte(r.length-e),t.writeBytes(r,e,r.length-e),t.writeByte(0),t.writeString(";")}},i=function(t){for(var r=1<<t,e=1+(1<<t),n=t+1,o=h(),i=0;i<r;i+=1)o.add(String.fromCharCode(i));o.add(String.fromCharCode(r)),o.add(String.fromCharCode(e));var a=p(),u=function(t){var e=t,n=0,o=0,r={write:function(t,r){if(t>>>r!=0)throw"length over";for(;8<=n+r;)e.writeByte(255&(t<<n|o)),r-=8-n,t>>>=8-n,n=o=0;o|=t<<n,n+=r},flush:function(){0<n&&e.writeByte(o)}};return r}(a);u.write(r,n);var f=0,c=String.fromCharCode(l[f]);for(f+=1;f<l.length;){var g=String.fromCharCode(l[f]);f+=1,o.contains(c+g)?c+=g:(u.write(o.indexOf(c),n),o.size()<4095&&(o.size()==1<<n&&(n+=1),o.add(c+g)),c=g)}return u.write(o.indexOf(c),n),u.write(e,n),u.flush(),a.toByteArray()},h=function(){var r={},e=0,n={add:function(t){if(n.contains(t))throw"dup key:"+t;r[t]=e,e+=1},size:function(){return e},indexOf:function(t){return r[t]},contains:function(t){return void 0!==r[t]}};return n};return e}(t,r),o=0;o<r;o+=1)for(var i=0;i<t;i+=1)n.setPixel(i,o,e(i,o));var a=p();n.write(a);for(var u=function(){function e(t){a+=String.fromCharCode(r(63&t))}var n=0,o=0,i=0,a="",t={},r=function(t){if(t<0);else{if(t<26)return 65+t;if(t<52)return t-26+97;if(t<62)return t-52+48;if(62==t)return 43;if(63==t)return 47}throw"n:"+t};return t.writeByte=function(t){for(n=n<<8|255&t,o+=8,i+=1;6<=o;)e(n>>>o-6),o-=6},t.flush=function(){if(0<o&&(e(n<<6-o),o=n=0),i%3!=0)for(var t=3-i%3,r=0;r<t;r+=1)a+="="},t.toString=function(){return a},t}(),f=a.toByteArray(),c=0;c<f.length;c+=1)u.writeByte(f[c]);return u.flush(),"data:image/gif;base64,"+u};return i}();qrcode.stringToBytesFuncs["UTF-8"]=function(t){return function(t){for(var r=[],e=0;e<t.length;e++){var n=t.charCodeAt(e);n<128?r.push(n):n<2048?r.push(192|n>>6,128|63&n):n<55296||57344<=n?r.push(224|n>>12,128|n>>6&63,128|63&n):(e++,n=65536+((1023&n)<<10|1023&t.charCodeAt(e)),r.push(240|n>>18,128|n>>12&63,128|n>>6&63,128|63&n))}return r}(t)},function(t){"function"==typeof define&&define.amd?define([],t):"object"==typeof exports&&(module.exports=t())}(function(){return qrcode});
  </script>
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
  <script>
    const urlParams = new URLSearchParams(window.location.search);
    let amount = ${finalAmount};
    if (isNaN(amount) || amount <= 0) amount = 100;

    let orderId = "${orderId}";
    let ticket = "${ticketParam}";
    let merchantUpi = "${MERCHANT_UPI_ID}";
    let merchantName = "${MERCHANT_NAME}";
    let userId = "${userId}";
    let pollInterval = null;
    let timerInterval = null;
    let secondsLeft = 600; // 10 minutes = 600 seconds
    let isFinished = false;

    function formatCurrency(amt) { return '₹' + amt.toFixed(2); }
    function generateUpiUri(amt) {
      return 'upi://pay?pa=' + encodeURIComponent(merchantUpi) +
             '&pn=' + encodeURIComponent(merchantName) +
             '&am=' + amt.toFixed(2) +
             '&cu=INR' +
             '&tr=' + encodeURIComponent(orderId);
    }

    function renderCircularQr() {
      if (isFinished) return;
      try {
        const upiUri = generateUpiUri(amount);
        if (typeof qrcode === 'undefined') return;
        const q = qrcode(0, 'H');
        q.addData(upiUri);
        q.make();

        const n = q.getModuleCount();
        const svgHtml = circ(q, n, '#000000', {
          text: 'UPI',
          fillDots: true,
          fontWeight: '800'
        });

        const box = document.getElementById('qrBox');
        if (box) box.innerHTML = svgHtml;
        const disp = document.getElementById('displayAmount');
        if (disp) disp.innerText = formatCurrency(amount);
        const sub = document.getElementById('paySubText');
        if (sub) sub.innerText = 'Scan QR or pay to ' + merchantName;
      } catch (err) {
        try {
          const upiUri = generateUpiUri(amount);
          const q = qrcode(0, 'M');
          q.addData(upiUri);
          q.make();
          const box = document.getElementById('qrBox');
          if (box) box.innerHTML = q.createSvgTag({ scalable: true });
        } catch (_) {}
      }
    }

    /* 10-Minute Countdown Timer System */
    function start10MinCountdown() {
      const badge = document.getElementById('timerBadge');
      const text = document.getElementById('timerText');

      function updateTimerDisplay() {
        if (secondsLeft <= 0) {
          clearInterval(timerInterval);
          text.innerText = '00:00';
          badge.className = 'timer-badge warning';
          triggerOrderExpired();
          return;
        }

        const mins = Math.floor(secondsLeft / 60);
        const secs = secondsLeft % 60;
        text.innerText = (mins < 10 ? '0' : '') + mins + ':' + (secs < 10 ? '0' : '') + secs;

        if (secondsLeft <= 120) {
          badge.className = 'timer-badge warning';
        }
        secondsLeft--;
      }

      updateTimerDisplay();
      timerInterval = setInterval(updateTimerDisplay, 1000);
    }

    /* Complete Order Expired Screen Trigger */
    function triggerOrderExpired() {
      if (isFinished) return;
      isFinished = true;
      if (pollInterval) clearInterval(pollInterval);

      document.getElementById('paymentCard').style.display = 'none';
      document.getElementById('successCard').style.display = 'none';
      const exp = document.getElementById('expiredCard');
      exp.className = 'card-expired active';
      document.getElementById('expOrderId').innerText = orderId;
      document.getElementById('expAmount').innerText = formatCurrency(amount);

      const headerTitle = document.querySelector('.header-title');
      if (headerTitle) headerTitle.innerText = 'Deposit Expired';
      const headerSub = document.querySelector('.header-subtitle');
      if (headerSub) headerSub.innerText = 'Session timed out after 10m';
      const timerText = document.getElementById('timerText');
      if (timerText) timerText.innerText = 'EXPIRED';
      const timerBadge = document.getElementById('timerBadge');
      if (timerBadge) {
        timerBadge.className = 'timer-badge warning';
        timerBadge.style.background = '#DC2626';
        timerBadge.style.borderColor = '#EF4444';
        timerBadge.style.color = '#FFFFFF';
      }
    }

    function restartDepositOrder() {
      window.location.reload();
    }

    /* Continuous Polling for Admin Approval */
    function startAdminApprovalPolling() {
      if (pollInterval) return;

      async function pollCheck() {
        if (isFinished) return;
        try {
          const res = await fetch('/api/v1/deposits/status?depositId=' + encodeURIComponent(orderId) + '&orderId=' + encodeURIComponent(orderId));
          const data = await res.json();
          if (data && data.success && data.data) {
            const st = (data.data.status || '').toUpperCase();
            if (st === 'APPROVED' || st === 'COMPLETED' || st === 'SUCCESS') {
              showSuccess(data.data);
            }
          }
        } catch (_) {}
      }

      pollInterval = setInterval(pollCheck, 2500);
      pollCheck();
    }

    function launchConfetti() {
      const canvas = document.getElementById('confettiCanvas');
      if (!canvas) return;
      canvas.style.display = 'block';
      canvas.width = canvas.offsetWidth || 480;
      canvas.height = canvas.offsetHeight || 800;
      const ctx = canvas.getContext('2d');
      const pieces = [];
      const colors = ['#10B981', '#34D399', '#F59E0B', '#3B82F6', '#EC4899', '#8B5CF6', '#FFFFFF'];
      for (let i = 0; i < 90; i++) {
        pieces.push({
          x: Math.random() * canvas.width,
          y: Math.random() * -canvas.height * 0.5,
          size: Math.random() * 8 + 4,
          color: colors[Math.floor(Math.random() * colors.length)],
          vx: (Math.random() - 0.5) * 3,
          vy: Math.random() * 4 + 2.5,
          rot: Math.random() * 360,
          vrot: (Math.random() - 0.5) * 8
        });
      }
      const start = Date.now();
      function render() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (let p of pieces) {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate((p.rot * Math.PI) / 180);
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
          ctx.restore();
          p.x += p.vx;
          p.y += p.vy;
          p.rot += p.vrot;
          if (p.y > canvas.height) {
            p.y = -10;
            p.x = Math.random() * canvas.width;
          }
        }
        if (Date.now() - start < 8000) {
          requestAnimationFrame(render);
        } else {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          canvas.style.display = 'none';
        }
      }
      render();
    }

    function showSuccess(orderData) {
      if (isFinished) return;
      isFinished = true;
      if (timerInterval) clearInterval(timerInterval);
      if (pollInterval) clearInterval(pollInterval);

      document.getElementById('paymentCard').style.display = 'none';
      document.getElementById('expiredCard').style.display = 'none';

      const succ = document.getElementById('successCard');
      succ.className = 'card-success active';
      document.getElementById('successAmountText').innerText = formatCurrency(orderData?.amountRupees || amount);
      document.getElementById('successOrderIdText').innerText = orderData?.depositId || orderId;
      document.getElementById('successTimeText').innerText = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      // Update header
      const headerTitle = document.querySelector('.header-title');
      if (headerTitle) headerTitle.innerText = 'Deposit Successful';
      const headerSub = document.querySelector('.header-subtitle');
      if (headerSub) headerSub.innerText = 'Payment received & approved';
      const timerBadge = document.getElementById('timerBadge');
      if (timerBadge) timerBadge.style.display = 'none';

      // Launch celebration confetti
      launchConfetti();

      // Synchronize in-app wallet balance if running inside WebView
      if (window.AndroidBridge && window.AndroidBridge.syncWalletBalance) {
        try {
          const paise = Math.round((orderData?.amountRupees || amount) * 100);
          window.AndroidBridge.syncWalletBalance(paise);
        } catch (_) {}
      }
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
      if (app === 'phonepe') targetUri = baseUri.replace('upi://', 'phonepe://');
      else if (app === 'gpay') targetUri = baseUri.replace('upi://', 'tez://upi/');
      else if (app === 'paytm') targetUri = baseUri.replace('upi://', 'paytmmp://');
      else if (app === 'whatsapp') targetUri = baseUri.replace('upi://', 'whatsapp://');
      window.location.href = targetUri;
    }

    function handleBack() {
      if (window.AndroidBridge && window.AndroidBridge.closeDeposit) window.AndroidBridge.closeDeposit();
      else if (window.history.length > 1) window.history.back();
      else window.close();
    }

    function handleReturnToGame() {
      if (window.AndroidBridge && window.AndroidBridge.onDepositSuccess) window.AndroidBridge.onDepositSuccess();
      else handleBack();
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
        const payload = { depositId: orderId, utr: utr, amountRupees: amount, userId: userId };
        const res = await fetch('/api/v1/deposits/submit-utr', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(ticket ? { 'X-Page-Ticket': ticket } : {})
          },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (data && data.success) {
          showAlert('UTR Submitted! Verifying approval with Admin...', false);
        } else {
          showAlert(data.message || 'Payment submitted! Verifying...', false);
        }
      } catch (err) {
        showAlert('UTR Submitted! Verifying approval with Admin...', false);
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>SUBMIT PAYMENT</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>';
      }
    }

    // Initialize systems
    renderCircularQr();
    start10MinCountdown();
    startAdminApprovalPolling();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', renderCircularQr);
    }
    window.addEventListener('load', renderCircularQr);
  </script>
</body>
</html>`;

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(html);
});
