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
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' wss: ws: https:;");
    next();
  });

  app.use(cors({
    origin: (origin, callback) => {
      // Allow native mobile apps, postman/curl (no origin)
      if (!origin) return callback(null, true);
      const isAllowedOrigin = allowedOrigins.includes(origin) || origin === 'https://admin-penal.vercel.app' || origin.endsWith('-satyamsk05s-projects.vercel.app');
      if (isAllowedOrigin) return callback(null, true);
      return callback(new Error('Origin blocked by CORS security policy'));
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
