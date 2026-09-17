import { Router } from 'express';
import { DepositController } from './deposit.controller';
import { WithdrawController } from './withdraw.controller';

export const paymentRoutes = Router();

// Deposits
paymentRoutes.post('/deposit/initiate', DepositController.initiate);
paymentRoutes.post('/deposit/utr', DepositController.submitUtr);
paymentRoutes.get('/deposits', DepositController.getDeposits);
paymentRoutes.post('/deposit/approve', DepositController.approve);
paymentRoutes.post('/deposit/reject', DepositController.reject);

// Withdrawals
paymentRoutes.post('/withdraw/request', WithdrawController.request);
paymentRoutes.get('/withdrawals', WithdrawController.getWithdrawals);
paymentRoutes.post('/withdraw/approve', WithdrawController.approve);
paymentRoutes.post('/withdraw/reject', WithdrawController.reject);
