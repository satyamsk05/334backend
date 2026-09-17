import http from 'http';
import { createApp } from './app';
import { envConfig } from './config/env.config';
import { DatabaseConfig } from './config/db.config';
import { SocketServer } from './sockets/socket.server';
import { Logger } from './utils/logger';

async function bootstrap() {
  const app = createApp();
  const server = http.createServer(app);

  // Initialize DB Pool & Socket Server
  DatabaseConfig.getPool();
  SocketServer.init(server);

  server.listen(envConfig.port, () => {
    Logger.info(`
==================================================
🚀 334GAME AUTHORITATIVE BACKEND CORE ONLINE!
🌐 REST API: http://localhost:${envConfig.port}/api/v1
👑 Admin Dashboard: http://localhost:${envConfig.port}/admin
📡 WebSockets: ws://localhost:${envConfig.port}/ws
🏥 Health Check: http://localhost:${envConfig.port}/api/v1/health
==================================================
    `);
  });
}

bootstrap().catch((err) => {
  Logger.error('❌ Server Bootstrap Error:', err);
  process.exit(1);
});
