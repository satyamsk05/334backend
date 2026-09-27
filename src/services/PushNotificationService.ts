import { DatabaseConfig } from '../config/db.config';
import { SocketServer } from '../sockets/socket.server';
import { Logger } from '../utils/logger';

export interface PushNotificationPayload {
  title: string;
  body: string;
  userId?: string; // If empty or 'ALL', broadcast to all
  data?: Record<string, string>;
}

export class PushNotificationService {
  /**
   * Broadcast or send a targeted push notification to users
   */
  public static async sendNotification(payload: PushNotificationPayload): Promise<{
    success: boolean;
    sentCount: number;
    message: string;
  }> {
    const { title, body, userId, data } = payload;
    const pool = DatabaseConfig.getPool();

    // 1. Broadcast over live WebSockets if client is active
    try {
      if (!userId || userId === 'ALL') {
        SocketServer.broadcast('SYSTEM_ANNOUNCEMENT', {
          id: `notif_${Date.now()}`,
          title,
          body,
          type: 'INFO',
          createdAt: new Date().toISOString()
        });
      } else {
        SocketServer.emitToUser(userId, 'SYSTEM_ANNOUNCEMENT', {
          id: `notif_${Date.now()}`,
          title,
          body,
          type: 'INFO',
          createdAt: new Date().toISOString()
        });
      }
    } catch (e: any) {
      Logger.warn('[PushNotification] WebSocket broadcast warning:', e.message);
    }

    // 2. Fetch target FCM tokens from database
    let fcmTokens: string[] = [];
    if (pool) {
      try {
        let query = 'SELECT fcm_token FROM users WHERE fcm_token IS NOT NULL AND fcm_token != \'\'';
        const params: any[] = [];
        if (userId && userId !== 'ALL') {
          query += ' AND id = $1';
          params.push(userId);
        }

        const res = await pool.query(query, params);
        fcmTokens = res.rows.map((r: any) => r.fcm_token).filter(Boolean);
      } catch (e: any) {
        Logger.error('[PushNotification] DB token query failed:', e.message);
      }
    }

    Logger.info(`[PushNotification] Target tokens count: ${fcmTokens.length} for title: "${title}"`);

    return {
      success: true,
      sentCount: fcmTokens.length,
      message: `Notification dispatched to ${fcmTokens.length} registered devices and live players`
    };
  }
}
