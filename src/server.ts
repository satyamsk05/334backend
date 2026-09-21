import http from 'http';
import { createApp } from './app';
import { envConfig } from './config/env.config';
import { DatabaseConfig } from './config/db.config';
import { RedisConfig } from './config/redis.config';
import { SocketServer } from './sockets/socket.server';
import { RingOfFutureEngine } from './game/RingOfFutureEngine';
import { Logger } from './utils/logger';

async function bootstrap() {
  const app = createApp();
  const server = http.createServer(app);
  let shuttingDown = false;

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  DatabaseConfig.getPool();
  SocketServer.init(server);

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    Logger.info(`[SERVER] ${signal} received. Starting graceful shutdown...`);

    const forceExitTimer = setTimeout(() => {
      Logger.error('[SERVER] Graceful shutdown timed out. Forcing exit.');
      process.exit(1);
    }, 10_000);
    forceExitTimer.unref();

    try {
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      });

      await SocketServer.close();
      await DatabaseConfig.close();
      await RedisConfig.close();

      clearTimeout(forceExitTimer);
      Logger.info('[SERVER] Graceful shutdown completed.');
      process.exit(0);
    } catch (error) {
      clearTimeout(forceExitTimer);
      Logger.error('[SERVER] Shutdown failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  server.on('error', (error) => {
    Logger.error('[SERVER] HTTP server error:', error.message);
  });

  // Start Authoritative Ring of Future Game Engine Loop
  RingOfFutureEngine.start();
  RingOfFutureEngine.onStateChange((state) => {
    SocketServer.broadcast('RING_OF_FUTURE_STATE', state);
  });

  server.listen(envConfig.port, () => {
    const host = process.env.PUBLIC_HOST || 'localhost';
    const isHttps = process.env.USE_HTTPS === 'true';
    const httpProto = isHttps ? 'https' : 'http';
    const wsProto = isHttps ? 'wss' : 'ws';

    Logger.info(`
==================================================
🚀 334GAME AUTHORITATIVE BACKEND CORE ONLINE!
🌐 Local API:     http://localhost:${envConfig.port}/api/v1
🌍 Public Server: ${httpProto}://${host}:${envConfig.port}/api/v1
👑 Admin Panel:   ${httpProto}://${host}:${envConfig.port}/admin
📡 WebSockets:    ${wsProto}://${host}:${envConfig.port}/ws
🏥 Health Check:  ${httpProto}://${host}:${envConfig.port}/api/v1/health
==================================================
    `);
  });
}

bootstrap().catch((err) => {
  Logger.error('❌ Server Bootstrap Error:', err);
  process.exit(1);
});
