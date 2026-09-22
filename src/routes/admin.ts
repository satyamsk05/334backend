import { Router, Request, Response } from 'express';
import { config } from '../config/env';
import { getAdminDashboardHtml } from './adminHtml';
import { FinancialService } from '../services/FinancialService';

export const adminRouter = Router();

// HTML Web UI Endpoint (Accessible in Browser at http://IP:4000/admin)
adminRouter.get('/', (req: Request, res: Response) => {
  res.send(getAdminDashboardHtml());
});

adminRouter.get('/ui', (req: Request, res: Response) => {
  res.send(getAdminDashboardHtml());
});

// Secret protection middleware for JSON API endpoints
adminRouter.use((req: Request, res: Response, next) => {
  if (req.query.secret) {
    return res.status(400).json({ success: false, message: 'Forbidden: Admin authentication via query parameters is disabled' });
  }

  const secret = req.headers['x-admin-secret'] as string;
  const configuredSecret = process.env.ADMIN_SECRET_KEY || process.env.ADMIN_PASSWORD;

  if (!configuredSecret) {
    return res.status(500).json({ success: false, message: 'Server configuration error: ADMIN_SECRET_KEY is not configured in .env' });
  }

  if (!secret || secret !== configuredSecret) {
    return res.status(401).json({ success: false, message: 'Unauthorized: Invalid Admin Secret Header' });
  }
  next();
});

adminRouter.get('/analytics', (req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      totalActivePlayers: 1,
      netHouseProfitRupees: 18450.00,
      totalRoundsPlayed: 8940,
      rtpVerifiedPercent: config.rtpTargetPercent
    }
  });
});

// Admin Deposit Queue & Action APIs
adminRouter.get('/deposits/pending', (req: Request, res: Response) => {
  const pending = FinancialService.getPendingDeposits();
  res.json({ success: true, data: pending });
});

adminRouter.post('/deposits/action', (req: Request, res: Response) => {
  const { depositId, action } = req.body;
  if (!depositId || !action) {
    return res.status(400).json({ success: false, message: 'depositId and action (APPROVE/REJECT) required' });
  }

  if (action === 'APPROVE') {
    const result = FinancialService.approveDeposit(depositId);
    return res.json(result);
  } else if (action === 'REJECT') {
    const result = FinancialService.rejectDeposit(depositId);
    return res.json(result);
  }

  res.status(400).json({ success: false, message: 'Invalid action' });
});

// Admin Withdrawal Queue & Action APIs
adminRouter.get('/withdrawals/pending', (req: Request, res: Response) => {
  const pending = FinancialService.getPendingWithdrawals();
  res.json({ success: true, data: pending });
});

adminRouter.post('/withdrawals/action', (req: Request, res: Response) => {
  const { withdrawalId, action } = req.body;
  if (!withdrawalId || !action) {
    return res.status(400).json({ success: false, message: 'withdrawalId and action (APPROVE/REJECT) required' });
  }

  if (action === 'APPROVE') {
    const result = FinancialService.approveWithdrawal(withdrawalId);
    return res.json(result);
  } else if (action === 'REJECT') {
    const result = FinancialService.rejectWithdrawal(withdrawalId);
    return res.json(result);
  }

  res.status(400).json({ success: false, message: 'Invalid action' });
});
