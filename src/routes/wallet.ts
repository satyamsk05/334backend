import { Router, Request, Response } from 'express';
import { WalletLedger } from '../services/WalletLedger';
import { TelegramBotService } from '../services/TelegramBotService';

export const walletRouter = Router();

walletRouter.get('/transactions', (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  if (!userId || !userId.trim()) {
    return res.status(400).json({ success: false, message: 'userId query parameter is required' });
  }
  const transactions = WalletLedger.getTransactions(userId);
  res.json({ success: true, data: transactions });
});

walletRouter.post('/deposit', async (req: Request, res: Response) => {
  const { userId, amountRupees, amountPaise, utr = '' } = req.body;
  if (!userId || typeof userId !== 'string' || !userId.trim()) {
    return res.status(400).json({ success: false, message: 'Valid userId is required' });
  }
  const paise = amountPaise ? parseInt(amountPaise, 10) : Math.round(parseFloat(amountRupees || '0') * 100);

  if (paise <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid deposit amount' });
  }

  const updatedBalance = WalletLedger.addDepositCash(userId, paise, utr);

  // Send Telegram notification
  await TelegramBotService.sendAlert(`💰 *Deposit Request Submitted*\nUser: \`${userId}\`\nAmount: ₹${(paise / 100).toFixed(2)}\nUTR: \`${utr || 'N/A'}\``);

  res.json({
    success: true,
    message: `₹${(paise / 100).toFixed(2)} added to wallet successfully!`,
    data: { walletBalance: updatedBalance }
  });
});

walletRouter.post('/withdraw', async (req: Request, res: Response) => {
  const { userId, amountRupees, amountPaise, upiId = '' } = req.body;
  if (!userId || typeof userId !== 'string' || !userId.trim()) {
    return res.status(400).json({ success: false, message: 'Valid userId is required' });
  }
  const paise = amountPaise ? parseInt(amountPaise, 10) : Math.round(parseFloat(amountRupees || '0') * 100);

  if (!upiId) {
    return res.status(400).json({ success: false, message: 'Please enter a valid UPI ID' });
  }

  const result = WalletLedger.requestWithdrawal(userId, paise, upiId);
  if (!result.success) {
    return res.status(400).json({ success: false, message: result.message });
  }

  // Send Telegram notification
  await TelegramBotService.sendAlert(`💸 *Withdrawal Requested*\nUser: \`${userId}\`\nAmount: ₹${(paise / 100).toFixed(2)}\nUPI ID: \`${upiId}\``);

  const updatedBalance = WalletLedger.getUserBalance(userId);
  res.json({
    success: true,
    message: result.message,
    data: { walletBalance: updatedBalance }
  });
});
