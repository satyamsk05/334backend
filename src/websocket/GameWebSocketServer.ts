import WebSocket, { WebSocketServer } from 'ws';
import { Server as HttpServer } from 'http';

export class GameWebSocketServer {
  private static wss: WebSocketServer | null = null;

  public static init(server: HttpServer): void {
    GameWebSocketServer.wss = new WebSocketServer({ server, path: '/ws' });

    GameWebSocketServer.wss.on('connection', (ws: WebSocket) => {
      console.log('📡 Client connected to WebSocket Server');

      ws.on('message', (message: string) => {
        try {
          const data = JSON.parse(message.toString());
          if (data.type === 'PING') {
            ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
          }
        } catch (e) {
          // ignore malformed message
        }
      });

      ws.on('close', () => {
        console.log('📡 Client disconnected from WebSocket');
      });
    });

    console.log('✅ WebSocket Server listening on /ws');
  }

  public static broadcast(type: string, payload: any): void {
    if (!GameWebSocketServer.wss) return;

    const data = JSON.stringify({ type, payload });
    GameWebSocketServer.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }
}
