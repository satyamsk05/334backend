import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { Logger } from '../utils/logger';
import { envConfig } from '../config/env.config';

interface AuthenticatedSocket extends WebSocket {
  userId?: string;
  isAlive?: boolean;
}

export class SocketServer {
  private static wss: WebSocketServer | null = null;
  private static clients = new Map<string, AuthenticatedSocket>();
  private static heartbeatTimer: NodeJS.Timeout | null = null;

  public static init(httpServer: HttpServer): WebSocketServer {
    SocketServer.wss = new WebSocketServer({
      server: httpServer,
      path: '/ws',
      maxPayload: 64 * 1024
    });

    SocketServer.wss.on('connection', (ws: AuthenticatedSocket, req) => {
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : '';

      if (!token) {
        ws.close(1008, 'Authentication required');
        return;
      }

      try {
        const decoded = jwt.verify(token, envConfig.jwtSecret) as jwt.JwtPayload;
        const userId = typeof decoded.userId === 'string'
          ? decoded.userId
          : typeof decoded.id === 'string'
            ? decoded.id
            : '';

        if (!userId) {
          ws.close(1008, 'Invalid authentication token');
          return;
        }

        const previousSocket = SocketServer.clients.get(userId);
        if (previousSocket && previousSocket !== ws) {
          previousSocket.close(1000, 'Replaced by a newer connection');
        }

        ws.userId = userId;
        ws.isAlive = true;
        SocketServer.clients.set(userId, ws);
        Logger.info(`[SOCKET] Authenticated client connected: ${userId}`);
      } catch (error) {
        ws.close(1008, 'Invalid authentication token');
        return;
      }

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', () => {
        // Client identity is always taken from the verified JWT.
      });

      ws.on('close', () => {
        if (ws.userId && SocketServer.clients.get(ws.userId) === ws) {
          SocketServer.clients.delete(ws.userId);
        }
        Logger.info(`[SOCKET] Client disconnected: ${ws.userId || 'unknown'}`);
      });

      ws.on('error', (error) => {
        Logger.error('[SOCKET] Client error:', error.message);
      });
    });

    SocketServer.heartbeatTimer = setInterval(() => {
      SocketServer.wss?.clients.forEach((client) => {
        const socket = client as AuthenticatedSocket;
        if (socket.isAlive === false) {
          socket.terminate();
          return;
        }
        socket.isAlive = false;
        socket.ping();
      });
    }, 30_000);

    SocketServer.wss.on('close', () => {
      if (SocketServer.heartbeatTimer) {
        clearInterval(SocketServer.heartbeatTimer);
        SocketServer.heartbeatTimer = null;
      }
      SocketServer.clients.clear();
      SocketServer.wss = null;
    });

    Logger.info('✅ WebSocket Server Initialized at /ws');
    return SocketServer.wss;
  }

  public static close(): Promise<void> {
    if (SocketServer.heartbeatTimer) {
      clearInterval(SocketServer.heartbeatTimer);
      SocketServer.heartbeatTimer = null;
    }

    SocketServer.wss?.clients.forEach((client) => {
      client.terminate();
    });
    SocketServer.clients.clear();

    return new Promise((resolve) => {
      if (!SocketServer.wss) return resolve();
      SocketServer.wss.close(() => resolve());
    });
  }

  public static emitToUser(userId: string, event: string, data: unknown): void {
    const ws = SocketServer.clients.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event, data }));
    }
  }

  public static getConnectedClientsCount(): number {
    return SocketServer.clients.size;
  }

  public static broadcast(event: string, data: unknown): void {
    if (!SocketServer.wss) return;
    const msg = JSON.stringify({ event, data });
    SocketServer.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    });
  }
}
