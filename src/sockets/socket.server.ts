import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { Logger } from '../utils/logger';
import { envConfig } from '../config/env.config';
import { RedisManager } from '../db/redis';

export interface AuthenticatedSocket extends WebSocket {
  userId?: string;
  isAlive?: boolean;
  rooms?: Set<string>;
}

export class SocketServer {
  private static wss: WebSocketServer | null = null;
  private static clients = new Map<string, AuthenticatedSocket>();
  private static rooms = new Map<string, Set<AuthenticatedSocket>>();
  private static heartbeatTimer: NodeJS.Timeout | null = null;
  private static isSubscribed = false;

  public static init(httpServer: HttpServer): WebSocketServer {
    SocketServer.wss = new WebSocketServer({
      server: httpServer,
      path: '/ws',
      maxPayload: 64 * 1024
    });

    SocketServer.initPubSub();

    SocketServer.wss.on('connection', (ws: AuthenticatedSocket, req) => {
      const authHeader = req.headers.authorization;
      let token = authHeader?.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : '';

      if (!token && req.url) {
        try {
          const parsedUrl = new URL(req.url, 'http://localhost');
          const queryToken = parsedUrl.searchParams.get('token');
          if (queryToken) {
            token = queryToken.trim();
          }
        } catch {}
      }

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
        ws.rooms = new Set();
        SocketServer.clients.set(userId, ws);
        Logger.info(`[SOCKET] Authenticated client connected: ${userId}`);
      } catch (error) {
        ws.close(1008, 'Invalid authentication token');
        return;
      }

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', (rawData) => {
        try {
          const msgStr = typeof rawData === 'string' ? rawData : rawData.toString();
          const parsed = JSON.parse(msgStr);
          const action = parsed.action || parsed.type;

          if (action === 'PING') {
            ws.send(JSON.stringify({ event: 'PONG', timestamp: Date.now() }));
            return;
          }

          if (action === 'JOIN_ROOM') {
            const roomId = parsed.roomId || parsed.room;
            if (roomId && typeof roomId === 'string') {
              SocketServer.joinRoom(roomId, ws);
              ws.send(JSON.stringify({ event: 'ROOM_JOINED', roomId }));
            }
            return;
          }

          if (action === 'LEAVE_ROOM') {
            const roomId = parsed.roomId || parsed.room;
            if (roomId && typeof roomId === 'string') {
              SocketServer.leaveRoom(roomId, ws);
              ws.send(JSON.stringify({ event: 'ROOM_LEFT', roomId }));
            }
            return;
          }

          // Message validation: If message targets a specific room, verify socket is in that room
          const targetRoomId = parsed.roomId || parsed.room;
          if (targetRoomId) {
            if (!ws.rooms || !ws.rooms.has(targetRoomId)) {
              Logger.warn(`[SOCKET] Unauthorized room action '${action}' by user ${ws.userId} for room ${targetRoomId}`);
              ws.send(JSON.stringify({
                event: 'ERROR',
                code: 'UNAUTHORIZED_ROOM_ACTION',
                message: 'You must join the room before sending messages to it'
              }));
              return;
            }
          }

          // Anti-spoofing: Always overwrite or bind userId with verified socket userId
          if (parsed.data && typeof parsed.data === 'object') {
            parsed.data.userId = ws.userId;
          }
        } catch {
          // Ignore malformed JSON
        }
      });

      ws.on('close', () => {
        if (ws.userId && SocketServer.clients.get(ws.userId) === ws) {
          SocketServer.clients.delete(ws.userId);
        }
        if (ws.rooms) {
          ws.rooms.forEach((roomId) => {
            SocketServer.leaveRoom(roomId, ws);
          });
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
      SocketServer.rooms.clear();
      SocketServer.wss = null;
    });

    Logger.info('✅ WebSocket Server Initialized at /ws');
    return SocketServer.wss;
  }

  private static initPubSub(): void {
    if (SocketServer.isSubscribed) return;
    SocketServer.isSubscribed = true;

    RedisManager.subscribe('ws:broadcast', (messageStr) => {
      try {
        const { event, data } = JSON.parse(messageStr);
        SocketServer.localBroadcast(event, data);
      } catch {}
    });

    RedisManager.subscribe('ws:user', (messageStr) => {
      try {
        const { userId, event, data } = JSON.parse(messageStr);
        SocketServer.localEmitToUser(userId, event, data);
      } catch {}
    });

    RedisManager.subscribe('ws:room', (messageStr) => {
      try {
        const { roomId, event, data } = JSON.parse(messageStr);
        SocketServer.localEmitToRoom(roomId, event, data);
      } catch {}
    });
  }

  public static joinRoom(roomId: string, ws: AuthenticatedSocket): void {
    if (!SocketServer.rooms.has(roomId)) {
      SocketServer.rooms.set(roomId, new Set());
    }
    SocketServer.rooms.get(roomId)!.add(ws);
    if (!ws.rooms) ws.rooms = new Set();
    ws.rooms.add(roomId);
  }

  public static leaveRoom(roomId: string, ws: AuthenticatedSocket): void {
    const roomSet = SocketServer.rooms.get(roomId);
    if (roomSet) {
      roomSet.delete(ws);
      if (roomSet.size === 0) SocketServer.rooms.delete(roomId);
    }
    ws.rooms?.delete(roomId);
  }

  public static isUserInRoom(roomId: string, userId: string): boolean {
    const ws = SocketServer.clients.get(userId);
    return Boolean(ws && ws.rooms && ws.rooms.has(roomId));
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
    SocketServer.rooms.clear();

    return new Promise((resolve) => {
      if (!SocketServer.wss) return resolve();
      SocketServer.wss.close(() => resolve());
    });
  }

  private static localEmitToUser(userId: string, event: string, data: unknown): void {
    const ws = SocketServer.clients.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event, data }));
    }
  }

  public static emitToUser(userId: string, event: string, data: unknown): void {
    SocketServer.localEmitToUser(userId, event, data);
    RedisManager.publish('ws:user', JSON.stringify({ userId, event, data })).catch(() => {});
  }

  private static localEmitToRoom(roomId: string, event: string, data: unknown): void {
    const sockets = SocketServer.rooms.get(roomId);
    if (sockets) {
      const msg = JSON.stringify({ event, data, roomId });
      sockets.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(msg);
        }
      });
    }
  }

  public static emitToRoom(roomId: string, event: string, data: unknown): void {
    SocketServer.localEmitToRoom(roomId, event, data);
    RedisManager.publish('ws:room', JSON.stringify({ roomId, event, data })).catch(() => {});
  }

  public static getConnectedClientsCount(): number {
    return SocketServer.clients.size;
  }

  private static localBroadcast(event: string, data: unknown): void {
    if (!SocketServer.wss) return;
    const msg = JSON.stringify({ event, data });
    SocketServer.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    });
  }

  public static broadcast(event: string, data: unknown): void {
    // Security check: Refuse to broadcast private wallet/financial events
    const sensitiveEvents = [
      'WALLET_UPDATE',
      'WALLET_UPDATED',
      'DEPOSIT_STATUS',
      'WITHDRAWAL_STATUS',
      'USER_BALANCE'
    ];
    if (sensitiveEvents.includes(event)) {
      Logger.error(
        `[SECURITY] Blocked attempt to broadcast sensitive event '${event}' to all clients! Use emitToUser() instead.`
      );
      return;
    }

    SocketServer.localBroadcast(event, data);
    RedisManager.publish('ws:broadcast', JSON.stringify({ event, data })).catch(() => {});
  }
}
