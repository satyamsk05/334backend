import express from 'express';
import cors from 'cors';
import path from 'path';
import { authRoutes } from './modules/auth/auth.routes';
import { walletRoutes } from './modules/wallet/wallet.routes';
import { paymentRoutes } from './modules/payments/payment.routes';
import { userRoutes } from './modules/users/user.routes';
import { adminRouter } from './routes/admin';
import { gamePageRouter } from './routes/gamePage';
import { depositPageRouter } from './routes/depositPage';
import { errorHandler } from './utils/errorHandler';
import { ResponseHandler } from './utils/responseHandler';
import { DatabaseConfig } from './config/db.config';
import { createRateLimiter } from './middleware/rateLimit';

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const globalRateLimit = createRateLimiter(60_000, 120);
const authRateLimit = createRateLimiter(60_000, 20);

export function createApp() {
  const app = express();

  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    next();
  });

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) return callback(null, true);
      return callback(new Error('Origin is not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-secret']
  }));
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  app.use(globalRateLimit);

  app.use(express.static(path.join(__dirname, '../public')));

  app.get('/api/v1/health', async (_req, res) => {
    const databaseHealthy = await DatabaseConfig.checkHealth();
    res.status(databaseHealthy ? 200 : 503).json({
      status: databaseHealthy ? 'ONLINE' : 'DEGRADED',
      service: '334game-backend-core',
      database: databaseHealthy ? 'ONLINE' : 'OFFLINE',
      timestamp: new Date().toISOString()
    });
  });

  app.use('/api/v1/auth', authRateLimit, authRoutes);
  app.use('/api/v1/wallet', walletRoutes);
  app.use('/api/v1/payments', paymentRoutes);
  app.use('/api/v1/users', userRoutes);
  app.use('/admin', adminRouter);
  app.use('/api/v1/admin', adminRouter);

  // Web Game and Payment Webpages (Ring Of Future UI & UPI Pay QR)
  app.use(gamePageRouter);
  app.use(depositPageRouter);

  app.use('/api', (_req, res) => ResponseHandler.error(res, 'Route not found', 404));
  app.use((_req, res) => ResponseHandler.error(res, 'Route not found', 404));

  // Global Error Handler
  app.use(errorHandler);

  return app;
}
