import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';
import { FinancialService } from '../services/FinancialService';

export const depositPageRouter = Router();

const MERCHANT_UPI_ID = process.env.PAYMENT_UPI_ID || process.env.MERCHANT_UPI_ID || 'satyamskk@ptyes';
const MERCHANT_NAME = process.env.PAYMENT_MERCHANT_NAME || process.env.MERCHANT_NAME || 'satyam';

// Deposit Initiate API
depositPageRouter.post('/api/v1/deposits/initiate', (req: Request, res: Response) => {
  const { userId = 'USR-304', amountRupees } = req.body;
  const num = parseFloat(amountRupees);
  if (isNaN(num) || num <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid deposit amount' });
  }

  // Reuse pending deposit if existing within 15 minutes to avoid duplicates
  const pending = FinancialService.getPendingDeposits();
  const existing = pending.find(
    (d) => d.userId === userId && Math.abs(d.amountRupees - num) < 0.01 && Date.now() - d.createdAt < 15 * 60 * 1000
  );

  const order = existing || FinancialService.initiateDeposit(userId, num);

  res.json({
    success: true,
    data: {
      depositId: order.depositId,
      amountRupees: order.amountRupees,
      payUrl: `/pay?orderId=${encodeURIComponent(order.depositId)}&userId=${encodeURIComponent(userId)}&amount=${order.amountRupees}`
    }
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

// UTR Submission API
depositPageRouter.post('/api/v1/deposits/submit-utr', (req: Request, res: Response) => {
  try {
    const { depositId, utr, userId, amountRupees } = req.body;
    if (!depositId) {
      return res.status(400).json({ success: false, message: 'Deposit ID is required' });
    }

    const parsedAmount = amountRupees ? parseFloat(amountRupees) : undefined;
    const result = FinancialService.submitUtr(depositId, utr, userId, parsedAmount);
    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json(result);
  } catch (err: any) {
    console.error('Error submitting UTR:', err);
    res.status(500).json({ success: false, message: err?.message || 'Error submitting UTR' });
  }
});

// Auto-UPI Payment Webpage
depositPageRouter.get('/pay', async (req: Request, res: Response) => {
  const rawUserId = (req.query.userId as string) || 'USR-304';
  const userId = /^[a-zA-Z0-9_-]+$/.test(rawUserId) ? rawUserId : 'USR-304';
  const amountStr = (req.query.amount as string) || '200';
  const rawOrderId = req.query.orderId as string;
  let orderId = rawOrderId && /^[a-zA-Z0-9_-]+$/.test(rawOrderId) ? rawOrderId : '';

  const amountRupees = Math.max(1, Math.min(50000, parseFloat(amountStr) || 200));

  // Idempotency: When visited without orderId (first landing or refresh), lock to existing pending order or create once
  if (!orderId) {
    const pending = FinancialService.getPendingDeposits();
    const existing = pending.find(
      (d) => d.userId === userId && Math.abs(d.amountRupees - amountRupees) < 0.01 && Date.now() - d.createdAt < 15 * 60 * 1000
    );

    if (existing) {
      orderId = existing.depositId;
    } else {
      const order = FinancialService.initiateDeposit(userId, amountRupees);
      orderId = order.depositId;
    }

    // Redirect to canonical URL with orderId so browser refresh NEVER creates a new request
    return res.redirect(302, `/pay?orderId=${encodeURIComponent(orderId)}&userId=${encodeURIComponent(userId)}&amount=${amountRupees}`);
  }

  // Load order details
  const existingOrder = FinancialService.getDeposit(orderId);
  const finalAmount = existingOrder ? existingOrder.amountRupees : amountRupees;
  const initialStatus = existingOrder ? existingOrder.status : 'PENDING';
  const hasUtr = !!(existingOrder && existingOrder.utr);

  const upiIntentUri = `upi://pay?pa=${encodeURIComponent(MERCHANT_UPI_ID)}&pn=${encodeURIComponent(MERCHANT_NAME)}&am=${finalAmount.toFixed(2)}&cu=INR&tr=${orderId}`;

  let qrCodeDataUrl = '';
  try {
    qrCodeDataUrl = await QRCode.toDataURL(upiIntentUri, { margin: 1, width: 280 });
  } catch (e) {
    qrCodeDataUrl = '';
  }

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>AUTO UPI Payment - 334Game</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; }
    body {
      background: #0E021A;
      color: #1A1A1A;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 16px;
    }
    
    .payment-wrapper {
      width: 100%;
      max-width: 390px;
      position: relative;
    }

    /* Primary Auto-UPI Card (Screenshots 1 & 2) */
    .card-upi {
      background: #FFFFFF;
      border-radius: 28px;
      padding: 24px 20px 20px 20px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4), 0 0 1px rgba(255, 255, 255, 0.2);
      position: relative;
      overflow: hidden;
      transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    }

    /* BHIM UPI Header */
    .bhim-header {
      display: flex;
      justify-content: center;
      align-items: center;
      margin-bottom: 12px;
    }
    .bhim-logo {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .bhim-text {
      font-size: 20px;
      font-weight: 900;
      font-style: italic;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, #097939 0%, #0054A6 60%, #F37023 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .upi-badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 6px;
      background: #097939;
      color: white;
      font-size: 11px;
      font-weight: 800;
      border-radius: 4px;
      margin-left: 2px;
    }

    .title-auto {
      text-align: center;
      font-size: 17px;
      font-weight: 800;
      color: #1F2937;
      letter-spacing: 0.5px;
    }
    .sub-transfer {
      text-align: center;
      font-size: 13px;
      color: #6B7280;
      margin-top: 2px;
      margin-bottom: 18px;
    }

    /* Total Amount Row */
    .amount-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 14px;
      background: #F8FAFC;
      border: 1px solid #E2E8F0;
      border-radius: 14px;
      margin-bottom: 16px;
    }
    .amount-label {
      font-size: 14px;
      font-weight: 600;
      color: #475569;
    }
    .amount-val {
      font-size: 24px;
      font-weight: 800;
      color: #0F172A;
      letter-spacing: -0.5px;
    }

    /* QR Code Box & Overlay */
    .qr-wrapper {
      position: relative;
      background: #FFFFFF;
      border: 1.5px solid #E2E8F0;
      border-radius: 20px;
      padding: 14px;
      display: flex;
      justify-content: center;
      align-items: center;
      margin-bottom: 14px;
      overflow: hidden;
    }
    .qr-img {
      width: 220px;
      height: 220px;
      display: block;
      border-radius: 8px;
    }

    /* Processing Overlay (Screenshot 2) */
    .processing-overlay {
      position: absolute;
      inset: 0;
      background: rgba(255, 255, 255, 0.92);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      display: none;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      z-index: 10;
      animation: fadeIn 0.3s ease;
    }
    .processing-overlay.active {
      display: flex;
    }
    .spinner-ring {
      width: 44px;
      height: 44px;
      border: 3.5px solid #E2E8F0;
      border-top-color: #10B981;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 12px;
    }
    .processing-text {
      font-size: 14px;
      font-weight: 700;
      color: #1E293B;
      letter-spacing: 0.2px;
    }
    .processing-sub {
      font-size: 11px;
      color: #64748B;
      margin-top: 4px;
    }

    /* Apps Row Icons */
    .apps-icons {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 16px;
      margin-bottom: 14px;
    }
    .app-icon-link {
      display: flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      transition: transform 0.15s;
    }
    .app-icon-link:active {
      transform: scale(0.9);
    }
    .app-badge {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: 800;
      color: white;
    }
    .bg-phonepe { background: #5F259F; }
    .bg-gpay { background: #FFFFFF; border: 1px solid #E2E8F0; }
    .bg-paytm { background: #00BAF2; }
    .bg-whatsapp { background: #25D366; }
    .bg-bhim { background: #0054A6; }
    .bg-airtel { background: #ED1C24; }

    /* Timer & Cancel Row */
    .timer-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0 4px;
      margin-bottom: 16px;
      font-size: 13px;
    }
    .timer-text {
      color: #64748B;
      font-weight: 600;
    }
    .timer-countdown {
      color: #0F172A;
      font-weight: 700;
    }
    .btn-cancel {
      color: #EF4444;
      font-weight: 700;
      background: none;
      border: none;
      cursor: pointer;
      font-size: 13px;
    }

    /* UTR Form */
    .utr-container {
      background: #F8FAFC;
      border: 1px solid #E2E8F0;
      border-radius: 16px;
      padding: 14px;
    }
    .utr-label {
      font-size: 11px;
      font-weight: 700;
      color: #64748B;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
      display: block;
    }
    .utr-field {
      width: 100%;
      background: #FFFFFF;
      border: 1.5px solid #CBD5E1;
      border-radius: 10px;
      padding: 11px 12px;
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 1.5px;
      text-align: center;
      color: #0F172A;
      outline: none;
      transition: border-color 0.2s;
      margin-bottom: 10px;
    }
    .utr-field:focus {
      border-color: #10B981;
    }
    .btn-submit {
      width: 100%;
      background: #10B981;
      color: #FFFFFF;
      border: none;
      border-radius: 10px;
      padding: 12px;
      font-size: 14px;
      font-weight: 800;
      letter-spacing: 0.5px;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
      transition: all 0.2s;
    }
    .btn-submit:active {
      transform: scale(0.98);
    }
    .btn-submit:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .status-msg {
      margin-top: 10px;
      font-size: 12px;
      text-align: center;
      display: none;
      font-weight: 600;
    }
    .status-msg.error { color: #DC2626; display: block; }
    .status-msg.success { color: #059669; display: block; }

    /* Success Screen (Screenshot 3) */
    .card-success {
      display: none;
      width: 100%;
      max-width: 390px;
      border-radius: 28px;
      overflow: hidden;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
      animation: scaleIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .card-success.active {
      display: block;
    }
    .success-top {
      background: linear-gradient(180deg, #059669 0%, #10B981 100%);
      padding: 36px 20px 28px 20px;
      text-align: center;
      color: white;
    }
    .check-circle {
      width: 72px;
      height: 72px;
      background: rgba(255, 255, 255, 0.25);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 16px auto;
      animation: pop 0.4s ease;
    }
    .check-inner {
      width: 54px;
      height: 54px;
      background: #FFFFFF;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .check-icon {
      width: 30px;
      height: 30px;
      stroke: #059669;
      stroke-width: 3.5;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .success-title {
      font-size: 22px;
      font-weight: 800;
      letter-spacing: -0.3px;
      margin-bottom: 6px;
    }
    .success-subtitle {
      font-size: 13px;
      opacity: 0.92;
      font-weight: 500;
    }
    .success-body {
      background: #FFFFFF;
      padding: 24px 20px;
    }
    .order-box {
      background: #F8FAFC;
      border: 1px solid #E2E8F0;
      border-radius: 16px;
      padding: 16px;
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 20px;
    }
    .order-icon {
      width: 44px;
      height: 44px;
      background: #F59E0B;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-size: 22px;
      flex-shrink: 0;
    }
    .order-info {
      flex: 1;
      min-width: 0;
    }
    .order-id-label {
      font-size: 12px;
      color: #64748B;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .order-amt {
      font-size: 22px;
      font-weight: 800;
      color: #0F172A;
      margin-top: 2px;
    }
    .order-id-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: 10px;
      border-top: 1px solid #F1F5F9;
      font-size: 12px;
      color: #64748B;
    }
    .btn-copy-id {
      background: none;
      border: none;
      color: #3B82F6;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
    }
    .btn-return-app {
      width: 100%;
      background: #0F172A;
      color: white;
      border: none;
      padding: 14px;
      border-radius: 12px;
      font-size: 15px;
      font-weight: 800;
      cursor: pointer;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes scaleIn {
      from { transform: scale(0.92); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }
    @keyframes pop {
      0% { transform: scale(0.6); }
      70% { transform: scale(1.1); }
      100% { transform: scale(1); }
    }
  </style>
</head>
<body>

  <div class="payment-wrapper">
    <!-- Screen 1 & 2: Payment & Processing Card -->
    <div class="card-upi" id="upiCard">
      <!-- BHIM UPI Logo Header -->
      <div class="bhim-header">
        <div class="bhim-logo">
          <span class="bhim-text">BHIM</span>
          <span class="upi-badge">UPI</span>
        </div>
      </div>
      
      <div class="title-auto">AUTO UPI</div>
      <div class="sub-transfer">Transfer to ${MERCHANT_NAME}</div>

      <!-- Amount Row -->
      <div class="amount-row">
        <span class="amount-label">Total Amount</span>
        <span class="amount-val">₹${finalAmount.toFixed(2)}</span>
      </div>

      <!-- QR Code with Processing Overlay -->
      <div class="qr-wrapper">
        <img src="${qrCodeDataUrl}" alt="UPI QR Code" class="qr-img" />
        <div class="processing-overlay ${hasUtr ? 'active' : ''}" id="processingOverlay">
          <div class="spinner-ring"></div>
          <div class="processing-text">Processing payment...</div>
          <div class="processing-sub">Awaiting Admin Verification</div>
        </div>
      </div>

      <!-- Payment Apps Row -->
      <div class="apps-icons">
        <a href="${upiIntentUri}" class="app-icon-link" title="PhonePe">
          <div class="app-badge bg-phonepe">P</div>
        </a>
        <a href="${upiIntentUri}" class="app-icon-link" title="Google Pay">
          <div class="app-badge bg-gpay"><span style="color:#4285F4;font-size:16px;">G</span></div>
        </a>
        <a href="${upiIntentUri}" class="app-icon-link" title="Paytm">
          <div class="app-badge bg-paytm"><span style="font-size:10px;">Pay</span></div>
        </a>
        <a href="${upiIntentUri}" class="app-icon-link" title="WhatsApp">
          <div class="app-badge bg-whatsapp">W</div>
        </a>
        <a href="${upiIntentUri}" class="app-icon-link" title="BHIM">
          <div class="app-badge bg-bhim">B</div>
        </a>
        <a href="${upiIntentUri}" class="app-icon-link" title="Airtel">
          <div class="app-badge bg-airtel">A</div>
        </a>
      </div>

      <!-- Expiry Countdown & Cancel -->
      <div class="timer-row">
        <div class="timer-text">Expire in <span class="timer-countdown" id="timerDisplay">03:50</span></div>
        <button class="btn-cancel" onclick="cancelPayment()">Cancel</button>
      </div>

      <!-- UTR Input Form -->
      <div class="utr-container">
        <label class="utr-label">Enter 12-Digit UTR / Ref No.</label>
        <input
          type="text"
          id="utrInput"
          class="utr-field"
          placeholder="e.g. 426819203814"
          maxlength="12"
          inputmode="numeric"
          ${hasUtr ? `value="${existingOrder?.utr || ''}" disabled` : ''}
        />
        <button
          class="btn-submit"
          id="btnSubmit"
          onclick="submitUtr()"
          ${hasUtr ? 'disabled' : ''}
        >
          ${hasUtr ? 'PAYMENT PROCESSING...' : 'SUBMIT PAYMENT'}
        </button>
        <div id="statusMsg" class="status-msg"></div>
      </div>
    </div>

    <!-- Screen 3: Payment Successful Card (Screenshot 3) -->
    <div class="card-success" id="successCard">
      <div class="success-top">
        <div class="check-circle">
          <div class="check-inner">
            <svg class="check-icon" viewBox="0 0 24 24">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>
        </div>
        <div class="success-title">Payment successful!</div>
        <div class="success-subtitle">Redirecting back to merchant's website...</div>
      </div>

      <div class="success-body">
        <div class="order-box">
          <div class="order-icon">🏪</div>
          <div class="order-info">
            <div class="order-id-label" id="successOrderIdLabel">${orderId}</div>
            <div class="order-amt">₹${finalAmount.toFixed(2)}</div>
          </div>
        </div>

        <div class="order-id-footer">
          <span>Order ID: <b id="successOrderIdDisplay">${orderId}</b></span>
          <button class="btn-copy-id" onclick="copyOrderId()">
            <span>Copy</span> 📋
          </button>
        </div>

        <div style="margin-top: 20px;">
          <button class="btn-return-app" onclick="returnToApp()">RETURN TO APP</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    const orderId = ${JSON.stringify(orderId)};
    const userId = ${JSON.stringify(userId)};
    const amountRupees = ${finalAmount};
    let initialStatus = ${JSON.stringify(initialStatus)};
    let pollInterval = null;

    // Timer Countdown (3 minutes 50 seconds = 230 seconds)
    let timeLeft = 230;
    const timerElem = document.getElementById('timerDisplay');
    const timerId = setInterval(() => {
      if (timeLeft <= 0) {
        clearInterval(timerId);
        timerElem.innerText = '00:00';
        return;
      }
      timeLeft--;
      const mins = String(Math.floor(timeLeft / 60)).padStart(2, '0');
      const secs = String(timeLeft % 60).padStart(2, '0');
      timerElem.innerText = mins + ':' + secs;
    }, 1000);

    function copyOrderId() {
      navigator.clipboard.writeText(orderId).then(() => {
        alert('Order ID copied: ' + orderId);
      });
    }

    function cancelPayment() {
      if (window.confirm('Are you sure you want to cancel this payment?')) {
        returnToApp();
      }
    }

    function returnToApp() {
      // Try custom deep link or close tab
      window.location.href = 'app334://payment-success?orderId=' + encodeURIComponent(orderId);
      setTimeout(() => {
        try { window.close(); } catch(e) {}
      }, 1000);
    }

    function showSuccessUI() {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      document.getElementById('upiCard').style.display = 'none';
      document.getElementById('successCard').className = 'card-success active';

      // Auto return after 4 seconds
      setTimeout(() => {
        returnToApp();
      }, 4000);
    }

    // Check status function
    async function checkOrderStatus() {
      try {
        const res = await fetch('/api/v1/deposits/status?orderId=' + encodeURIComponent(orderId));
        if (!res.ok) return;
        const json = await res.json();
        if (json.success && json.data) {
          const status = json.data.status;
          if (status === 'APPROVED') {
            showSuccessUI();
          } else if (status === 'REJECTED') {
            const overlay = document.getElementById('processingOverlay');
            overlay.className = 'processing-overlay';
            const msg = document.getElementById('statusMsg');
            msg.className = 'status-msg error';
            msg.innerText = 'Deposit rejected by Admin.';
            if (pollInterval) clearInterval(pollInterval);
          }
        }
      } catch (e) {
        // Network polling error - continue
      }
    }

    async function submitUtr() {
      const input = document.getElementById('utrInput');
      const btn = document.getElementById('btnSubmit');
      const msg = document.getElementById('statusMsg');
      const utr = input.value.trim();

      if (utr.length < 6) {
        msg.className = 'status-msg error';
        msg.innerText = 'Please enter a valid 12-digit UTR number';
        return;
      }

      msg.className = 'status-msg';
      msg.innerText = '';
      btn.disabled = true;
      btn.innerText = 'SUBMITTING...';

      try {
        const res = await fetch('/api/v1/deposits/submit-utr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            depositId: orderId,
            utr: utr,
            userId: userId,
            amountRupees: amountRupees
          })
        });
        const data = await res.json();

        if (data.success) {
          input.disabled = true;
          btn.innerText = 'PAYMENT PROCESSING...';
          // Show frosted glass processing overlay over QR code (Screenshot 2)
          document.getElementById('processingOverlay').className = 'processing-overlay active';
          startPolling();
        } else {
          msg.className = 'status-msg error';
          msg.innerText = data.message || 'Submission failed';
          btn.disabled = false;
          btn.innerText = 'SUBMIT PAYMENT';
        }
      } catch (err) {
        msg.className = 'status-msg error';
        msg.innerText = 'Network error. Please try again.';
        btn.disabled = false;
        btn.innerText = 'SUBMIT PAYMENT';
      }
    }

    function startPolling() {
      if (pollInterval) return;
      pollInterval = setInterval(checkOrderStatus, 2000);
      checkOrderStatus();
    }

    // If order is already submitted or approved on page load
    if (initialStatus === 'APPROVED') {
      showSuccessUI();
    } else if (document.getElementById('processingOverlay').classList.contains('active')) {
      startPolling();
    } else {
      // Periodic check even before UTR submission in case admin auto-approves
      setInterval(checkOrderStatus, 3500);
    }
  </script>
</body>
</html>
  `;

  res.send(html);
});
