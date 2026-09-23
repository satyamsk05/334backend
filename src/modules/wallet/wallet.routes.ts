import { Router } from 'express';
import { WalletController } from './wallet.controller';
import { optionalAuthenticateJwt } from '../auth/auth.middleware';

export const walletRoutes = Router();

walletRoutes.get('/balance', optionalAuthenticateJwt, WalletController.getBalance);
walletRoutes.get('/transactions', optionalAuthenticateJwt, WalletController.getTransactions);

