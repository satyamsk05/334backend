import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';
import { FinancialService } from '../services/FinancialService';

export const depositPageRouter = Router();

const MERCHANT_UPI_ID = process.env.PAYMENT_UPI_ID || process.env.MERCHANT_UPI_ID || 'satyamskk@ptyes';
const MERCHANT_NAME = process.env.PAYMENT_MERCHANT_NAME || process.env.MERCHANT_NAME || 'satyam';

depositPageRouter.post('/api/v1/deposits/initiate', (req: Request, res: Response) => {
  const { userId = 'USR-304', amountRupees } = req.body;
  const num = parseFloat(amountRupees);
  if (isNaN(num) || num <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid deposit amount' });
  }

  const order = FinancialService.initiateDeposit(userId, num);
  res.json({
    success: true,
    data: {
      depositId: order.depositId,
      amountRupees: order.amountRupees,
      payUrl: `/pay?orderId=${order.depositId}`
    }
  });
});

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

depositPageRouter.get('/pay', async (req: Request, res: Response) => {
  const rawUserId = (req.query.userId as string) || 'USR-304';
  const userId = /^[a-zA-Z0-9_-]+$/.test(rawUserId) ? rawUserId : 'USR-304';
  const amountStr = (req.query.amount as string) || '200';
  const rawOrderId = req.query.orderId as string;
  let orderId = rawOrderId && /^[a-zA-Z0-9_-]+$/.test(rawOrderId) ? rawOrderId : '';

  const amountRupees = Math.max(10, Math.min(50000, parseFloat(amountStr) || 200));

  if (!orderId) {
    const order = FinancialService.initiateDeposit(userId, amountRupees);
    orderId = order.depositId;
  }

  const upiIntentUri = `upi://pay?pa=${encodeURIComponent(MERCHANT_UPI_ID)}&pn=${encodeURIComponent(MERCHANT_NAME)}&am=${amountRupees.toFixed(2)}&cu=INR&tr=${orderId}`;

  let qrCodeDataUrl = '';
  try {
    qrCodeDataUrl = await QRCode.toDataURL(upiIntentUri, { margin: 1, width: 250 });
  } catch (e) {
    qrCodeDataUrl = '';
  }

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>UPI Deposit - 334Game</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Outfit', sans-serif; }
    body { background: #0F0417; color: #FFFFFF; min-height: 100vh; display: flex; justify-content: center; align-items: center; padding: 16px; }
    .card { background: #1C082E; border: 1px solid #4C1D95; border-radius: 20px; width: 100%; max-width: 440px; padding: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    .header { text-align: center; margin-bottom: 20px; }
    .header h1 { font-size: 22px; font-weight: 800; color: #A78BFA; }
    .header p { font-size: 13px; color: #9CA3AF; margin-top: 4px; }
    .amount-box { background: #2A0B45; border: 1.5px dashed #7C3AED; border-radius: 14px; padding: 16px; text-align: center; margin-bottom: 20px; }
    .amount-box .label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #9CA3AF; font-weight: 700; }
    .amount-box .val { font-size: 32px; font-weight: 800; color: #10B981; margin-top: 4px; }
    .qr-container { background: #FFFFFF; padding: 12px; border-radius: 16px; display: inline-block; margin-bottom: 16px; }
    .qr-container img { width: 220px; height: 220px; display: block; }
    .vpa-box { background: #240A3C; border: 1px solid #5B21B6; border-radius: 12px; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
    .vpa-text { font-size: 14px; font-weight: 700; color: #DDD6FE; font-family: monospace; }
    .btn-copy { background: #7C3AED; color: white; border: none; padding: 6px 14px; border-radius: 8px; font-size: 12px; font-weight: 700; cursor: pointer; }
    .btn-copy:active { transform: scale(0.96); }
    .apps-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 24px; }
    .app-btn { background: #2A0B45; border: 1px solid #4C1D95; border-radius: 12px; padding: 12px; text-align: center; text-decoration: none; color: white; font-size: 12px; font-weight: 700; transition: all 0.2s; }
    .app-btn:hover { background: #3B0F61; border-color: #8B5CF6; }
    .utr-form { background: #160424; border: 1px solid #37145A; border-radius: 14px; padding: 16px; }
    .utr-form label { font-size: 12px; font-weight: 700; color: #C4B5FD; display: block; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
    .utr-input { width: 100%; background: #240A3C; border: 1px solid #5B21B6; border-radius: 10px; padding: 12px; font-size: 16px; font-weight: 700; color: #FFFFFF; letter-spacing: 2px; text-align: center; outline: none; margin-bottom: 12px; }
    .utr-input::placeholder { font-weight: 400; letter-spacing: normal; color: #6B7280; font-size: 14px; }
    .btn-submit { width: 100%; background: linear-gradient(135deg, #10B981 0%, #047857 100%); color: white; border: none; padding: 14px; border-radius: 10px; font-size: 15px; font-weight: 800; cursor: pointer; letter-spacing: 0.5px; }
    .btn-submit:disabled { opacity: 0.5; cursor: not-allowed; }
    .status-alert { margin-top: 12px; padding: 10px; border-radius: 8px; font-size: 13px; text-align: center; display: none; }
    .status-alert.success { background: rgba(16, 185, 129, 0.15); color: #34D399; border: 1px solid #059669; }
    .status-alert.error { background: rgba(239, 68, 68, 0.15); color: #FCA5A5; border: 1px solid #DC2626; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>334Game Deposit</h1>
      <p>Scan QR or Pay via any UPI App</p>
    </div>

    <div class="amount-box">
      <div class="label">Payable Amount</div>
      <div class="val">₹${amountRupees.toFixed(2)}</div>
    </div>

    <div style="text-align: center;">
      <div class="qr-container">
        <img src="${qrCodeDataUrl}" alt="UPI Payment QR Code" />
      </div>
    </div>

    <div class="vpa-box">
      <span class="vpa-text" id="vpaText">${MERCHANT_UPI_ID}</span>
      <button class="btn-copy" onclick="copyVpa()">COPY</button>
    </div>

    <div class="apps-row">
      <a href="${upiIntentUri}" class="app-btn">⚡ PhonePe</a>
      <a href="${upiIntentUri}" class="app-btn">⚡ GPay</a>
      <a href="${upiIntentUri}" class="app-btn">⚡ Paytm</a>
    </div>

    <div class="utr-form">
      <label>Enter 12-Digit UTR / Ref No.</label>
      <input type="text" id="utrInput" class="utr-input" placeholder="e.g. 426819203814" maxlength="12" />
      <button class="btn-submit" id="btnSubmit" onclick="submitUtr()">SUBMIT PAYMENT</button>
      <div id="statusAlert" class="status-alert"></div>
    </div>
  </div>

  <script>
    const orderId = ${JSON.stringify(orderId)};
    const depositUserId = ${JSON.stringify(userId)};
    const depositAmount = ${amountRupees};

    function copyVpa() {
      const vpa = document.getElementById('vpaText').innerText;
      navigator.clipboard.writeText(vpa).then(() => {
        alert('UPI ID copied to clipboard: ' + vpa);
      });
    }

    async function submitUtr() {
      const utrInput = document.getElementById('utrInput');
      const btnSubmit = document.getElementById('btnSubmit');
      const alertBox = document.getElementById('statusAlert');

      const utr = utrInput.value.trim();
      if (utr.length < 6) {
        alertBox.className = 'status-alert error';
        alertBox.innerText = 'Please enter a valid 12-digit UTR number';
        alertBox.style.display = 'block';
        return;
      }

      btnSubmit.disabled = true;
      btnSubmit.innerText = 'SUBMITTING...';

      try {
        const res = await fetch('/api/v1/deposits/submit-utr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            depositId: orderId,
            utr: utr,
            userId: depositUserId,
            amountRupees: depositAmount
          })
        });
        const data = await res.json();

        if (data.success) {
          alertBox.className = 'status-alert success';
          alertBox.innerText = '✅ ' + data.message;
          alertBox.style.display = 'block';
          btnSubmit.innerText = 'SUBMITTED FOR APPROVAL';
        } else {
          alertBox.className = 'status-alert error';
          alertBox.innerText = '❌ ' + (data.message || 'Submission failed');
          alertBox.style.display = 'block';
          btnSubmit.disabled = false;
          btnSubmit.innerText = 'SUBMIT PAYMENT';
        }
      } catch (err) {
        alertBox.className = 'status-alert error';
        alertBox.innerText = '❌ Network error. Please try again.';
        alertBox.style.display = 'block';
        btnSubmit.disabled = false;
        btnSubmit.innerText = 'SUBMIT PAYMENT';
      }
    }
  </script>
</body>
</html>
  `;

  res.send(html);
});
