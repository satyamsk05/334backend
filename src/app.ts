import express from 'express';
import cors from 'cors';
import path from 'path';
import { authRoutes } from './modules/auth/auth.routes';
import { walletRoutes } from './modules/wallet/wallet.routes';
import { paymentRoutes } from './modules/payments/payment.routes';
import { userRoutes } from './modules/users/user.routes';
import { promotionRoutes } from './modules/promotions/promotion.routes';
import { adminRoutes } from './modules/admin/admin.routes';
import { adminRouter } from './routes/admin';
import { gamePageRouter } from './routes/gamePage';
import { depositPageRouter } from './routes/depositPage';
import { errorHandler } from './utils/errorHandler';
import { ResponseHandler } from './utils/responseHandler';
import { DatabaseConfig } from './config/db.config';
import { createRateLimiter, adminLoginRateLimit } from './middleware/rateLimit';
import xoGameRouter from './routes/xoGame';

const corsOriginEnv = process.env.CORS_ORIGIN || process.env.ALLOWED_ORIGINS;
const allowedOrigins = corsOriginEnv && corsOriginEnv !== '*'
  ? corsOriginEnv.split(',').map((origin) => origin.trim()).filter(Boolean)
  : [];

const globalRateLimit = createRateLimiter(60_000, 120);
const authRateLimit = createRateLimiter(60_000, 20);

export function isAllowedCorsOrigin(origin: string | undefined): boolean {
  // Allow native mobile apps, postman/curl, server-to-server without origin header, or local file asset webviews
  if (!origin || origin === 'null' || origin === 'file://') return true;

  try {
    const url = new URL(origin);
    const host = url.hostname;

    // Allow localhost and local loopback during development
    if (process.env.NODE_ENV !== 'production' && (host === 'localhost' || host === '127.0.0.1')) {
      return true;
    }

    // Allow configured server public host (deposit page, game page)
    const publicHost = process.env.PUBLIC_HOST;
    if (publicHost && host === publicHost) {
      return true;
    }

    // Allow exact verified Admin panel and Payment Gateway origins only (NO arbitrary *.vercel.app wildcard)
    if (origin === 'https://adminpenal-six.vercel.app' || origin === 'https://bitarcade-pay.vercel.app') {
      return true;
    }

    // Allow explicitly configured origins
    if (allowedOrigins.includes(origin) || allowedOrigins.includes(url.origin)) {
      return true;
    }

    // Disallow all other origins
    return false;
  } catch {
    return false;
  }
}

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

    // Build connect-src from env rather than wildcards
    const publicHost = process.env.PUBLIC_HOST;
    const backendWsOrigin = publicHost
      ? `wss://${publicHost} ws://${publicHost}`
      : (process.env.NODE_ENV !== 'production' ? 'ws://localhost:4001 wss://localhost:4001' : '');
    const connectSrc = [`'self'`, backendWsOrigin].filter(Boolean).join(' ');

    // NOTE: script-src retains 'unsafe-inline' because the game page (/game) and deposit page
    // (/deposit) serve inline <script> blocks from gamePage.ts and depositPage.ts.
    // These are server-rendered HTML pages, not the admin panel.
    // The admin panel enforces CSP separately via next.config.js (allows unsafe-inline for Next hydration).
    res.setHeader('Content-Security-Policy',
      `default-src 'self'; ` +
      `script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; ` +
      `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; ` +
      `font-src 'self' https://fonts.gstatic.com; ` +
      `img-src 'self' data:; ` +
      `connect-src ${connectSrc};`
    );
    next();
  });

  app.use(cors({
    origin: (origin, callback) => {
      return callback(null, isAllowedCorsOrigin(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-User-Id', 'x-user-id']
  }));
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  app.use(globalRateLimit);

  app.use(express.static(path.join(__dirname, '../public')));

  app.get('/api/v1/health', async (_req, res) => {
    // Minimal public health check — reveals ONLY up/down status.
    // Internal service name, database backend, and infra details are intentionally omitted
    // to avoid fingerprinting and reconnaissance by attackers.
    const databaseHealthy = await DatabaseConfig.checkHealth();
    res.status(databaseHealthy ? 200 : 503).json({
      status: databaseHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString()
    });
  });

  // Admin login has a tighter brute-force limiter (5 req / 15 min) applied before the general authRateLimit
  app.post('/api/v1/auth/admin/login', adminLoginRateLimit);
  app.use('/api/v1/auth', authRateLimit, authRoutes);
  app.use('/api/v1/wallet', walletRoutes);
  app.use('/api/v1/payments', paymentRoutes);
  app.use('/api/v1/users', userRoutes);
  app.use('/users', userRoutes);
  app.use('/api/v1/promotions', promotionRoutes);
  app.use('/promotions', promotionRoutes);
  app.use('/admin', adminRouter);
  app.use('/api/v1/admin', adminRoutes);

  app.use('/api/v1/games/xo', xoGameRouter);

  // Web Game and Payment Webpages (Ring Of Future UI & UPI Pay QR)
  app.use(gamePageRouter);
  app.use(depositPageRouter);

  app.use('/api', (_req, res) => ResponseHandler.error(res, 'Route not found', 404));
  app.use((_req, res) => ResponseHandler.error(res, 'Route not found', 404));

  // Global Error Handler
  app.use(errorHandler);

  return app;
}
