import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Logger } from '../utils/logger';

export class SocketServer {
  private static wss: WebSocketServer | null = null;
  private static clients = new Map<string, WebSocket>();

  public static init(httpServer: HttpServer): WebSocketServer {
    SocketServer.wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    SocketServer.wss.on('connection', (ws: WebSocket, req) => {
      Logger.info('[SOCKET] Client connected to /ws');

      ws.on('message', (message: string) => {
        try {
          const payload = JSON.parse(message.toString());
          if (payload.action === 'join' && payload.userId) {
            SocketServer.clients.set(payload.userId, ws);
            Logger.info(`[SOCKET] User ${payload.userId} registered socket`);
          }
        } catch (e) {
          // Non-JSON message
        }
      });

      ws.on('close', () => {
        Logger.info('[SOCKET] Client disconnected');
      });
    });

    Logger.info('✅ WebSocket Server Initialized at /ws');
    return SocketServer.wss;
  }

  public static emitToUser(userId: string, event: string, data: any): void {
    const ws = SocketServer.clients.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event, data }));
    }
  }

  public static broadcast(event: string, data: any): void {
    if (SocketServer.wss) {
      const msg = JSON.stringify({ event, data });
      SocketServer.wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(msg);
        }
      });
    }
  }
}
