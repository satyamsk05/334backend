import express from 'express';
import cors from 'cors';
import path from 'path';
import { authRoutes } from './modules/auth/auth.routes';
import { walletRoutes } from './modules/wallet/wallet.routes';
import { paymentRoutes } from './modules/payments/payment.routes';
import { userRoutes } from './modules/users/user.routes';
import { adminRouter } from './routes/admin';
import { errorHandler } from './utils/errorHandler';

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Static web assets
  app.use(express.static(path.join(__dirname, '../public')));

  // Health check
  app.get('/api/v1/health', (req, res) => {
    res.json({
      status: 'ONLINE',
      service: '334game-backend-core',
      timestamp: new Date().toISOString()
    });
  });

  // Feature Module Routers
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/wallet', walletRoutes);
  app.use('/api/v1/payments', paymentRoutes);
  app.use('/api/v1/users', userRoutes);
  app.use('/admin', adminRouter);

  // Global Error Handler
  app.use(errorHandler);

  return app;
}
