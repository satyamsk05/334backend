import express from 'express';
import cors from 'cors';
import path from 'path';
import { authRoutes } from './modules/auth/auth.routes';
import { walletRoutes } from './modules/wallet/wallet.routes';
import { paymentRoutes } from './modules/payments/payment.routes';
import { userRoutes } from './modules/users/user.routes';
import { adminRoutes } from './modules/admin/admin.routes';
import { adminRouter } from './routes/admin';
import { gamePageRouter } from './routes/gamePage';
import { depositPageRouter } from './routes/depositPage';
import { errorHandler } from './utils/errorHandler';
import { ResponseHandler } from './utils/responseHandler';
import { DatabaseConfig } from './config/db.config';
import { createRateLimiter } from './middleware/rateLimit';

const corsOriginEnv = process.env.CORS_ORIGIN || process.env.ALLOWED_ORIGINS;
const allowedOrigins = corsOriginEnv && corsOriginEnv !== '*'
  ? corsOriginEnv.split(',').map((origin) => origin.trim()).filter(Boolean)
  : [];

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
      // Allow native mobile apps, postman/curl, same-origin without origin header
      if (!origin) return callback(null, true);

      // If CORS_ORIGIN is set to '*' or non-production, allow all
      if (corsOriginEnv === '*' || process.env.NODE_ENV !== 'production') {
        return callback(null, true);
      }

      try {
        const url = new URL(origin);
        const host = url.hostname;

        // Allow localhost and local loopback on any port
        if (host === 'localhost' || host === '127.0.0.1') {
          return callback(null, true);
        }

        // Allow EC2 server public host/IP on any port (deposit page, game page)
        const publicHost = process.env.PUBLIC_HOST || '3.7.73.109';
        if (host === publicHost || host === '3.7.73.109') {
          return callback(null, true);
        }

        // Allow Admin panel on Vercel (production & preview deployments)
        if (
          origin === 'https://admin-penal.vercel.app' ||
          host.endsWith('.vercel.app')
        ) {
          return callback(null, true);
        }

        // Allow explicitly configured origins
        if (allowedOrigins.includes(origin) || allowedOrigins.includes(url.origin)) {
          return callback(null, true);
        }

        // Gracefully disallow unknown external origin without throwing a 500 error
        return callback(null, false);
      } catch {
        return callback(null, false);
      }
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
  app.use('/api/v1/admin', adminRoutes);

  // Web Game and Payment Webpages (Ring Of Future UI & UPI Pay QR)
  app.use(gamePageRouter);
  app.use(depositPageRouter);

  app.use('/api', (_req, res) => ResponseHandler.error(res, 'Route not found', 404));
  app.use((_req, res) => ResponseHandler.error(res, 'Route not found', 404));

  // Global Error Handler
  app.use(errorHandler);

  return app;
}
