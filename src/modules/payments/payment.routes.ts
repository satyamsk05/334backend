import { Router } from 'express';
import { DepositController } from './deposit.controller';
import { WithdrawController } from './withdraw.controller';
import { authenticateJwt, authenticateAdmin } from '../auth/auth.middleware';

export const paymentRoutes = Router();

// User Actions (Require JWT Authentication)
paymentRoutes.post('/deposit/initiate', authenticateJwt, DepositController.initiate);
paymentRoutes.post('/deposit/utr', DepositController.submitUtr);
paymentRoutes.post('/withdraw/request', authenticateJwt, WithdrawController.request);

// Admin-Only Financial Operations
paymentRoutes.get('/deposits', authenticateAdmin, DepositController.getDeposits);
paymentRoutes.post('/deposit/approve', authenticateAdmin, DepositController.approve);
paymentRoutes.post('/deposit/reject', authenticateAdmin, DepositController.reject);

paymentRoutes.get('/withdrawals', authenticateAdmin, WithdrawController.getWithdrawals);
paymentRoutes.post('/withdraw/approve', authenticateAdmin, WithdrawController.approve);
paymentRoutes.post('/withdraw/reject', authenticateAdmin, WithdrawController.reject);

