import { Router } from 'express';
import { WalletController } from './wallet.controller';
import { authenticateJwt } from '../auth/auth.middleware';

export const walletRoutes = Router();

walletRoutes.get('/balance', authenticateJwt, WalletController.getBalance);
walletRoutes.get('/transactions', authenticateJwt, WalletController.getTransactions);
