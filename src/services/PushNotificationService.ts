import fs from 'fs';
import path from 'path';
import { initializeApp, cert, getApps, App } from 'firebase-admin/app';
import { getMessaging, MulticastMessage } from 'firebase-admin/messaging';
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
  private static app: App | null = null;

  /**
   * Auto-initialize Firebase Admin SDK if service account file is available
   */
  private static initFirebase(): boolean {
    if (this.app) return true;

    try {
      const apps = getApps();
      if (apps.length > 0) {
        this.app = apps[0];
        return true;
      }

      // 1. Check environment variable for service account credentials (preferred in production / secrets manager)
      const envServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      if (envServiceAccount) {
        let serviceAccount: any;
        try {
          serviceAccount = JSON.parse(envServiceAccount);
        } catch {
          // Attempt base64 decode if encoded
          const decoded = Buffer.from(envServiceAccount, 'base64').toString('utf8');
          serviceAccount = JSON.parse(decoded);
        }
        this.app = initializeApp({
          credential: cert(serviceAccount)
        });
        Logger.info('[PushNotification] Firebase Admin SDK successfully initialized from environment variable');
        return true;
      }

      // 2. Check candidate locations for service account key (local development fallback)
      const candidateDirs = [
        process.cwd(),
        path.resolve(__dirname, '../../'),
        path.resolve(__dirname, '../'),
        '/app'
      ];

      let foundPath: string | null = null;
      let foundFileName = '';

      for (const dir of candidateDirs) {
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir);
          const serviceAccountFile = files.find(
            (f) => f.includes('firebase-adminsdk') && f.endsWith('.json')
          );
          if (serviceAccountFile) {
            foundPath = path.join(dir, serviceAccountFile);
            foundFileName = serviceAccountFile;
            break;
          }
        }
      }

      if (foundPath) {
        const serviceAccount = JSON.parse(fs.readFileSync(foundPath, 'utf8'));

        this.app = initializeApp({
          credential: cert(serviceAccount)
        });

        Logger.info(`[PushNotification] Firebase Admin SDK successfully initialized from ${foundFileName}`);
        return true;
      } else {
        Logger.warn('[PushNotification] No Firebase service account configured (set FIREBASE_SERVICE_ACCOUNT env var).');
        return false;
      }
    } catch (err: any) {
      Logger.error('[PushNotification] Failed to initialize Firebase Admin SDK:', err.message);
      return false;
    }
  }

  /**
   * Broadcast or send a targeted push notification to users via FCM & Live WebSockets
   */
  public static async sendNotification(payload: PushNotificationPayload): Promise<{
    success: boolean;
    sentCount: number;
    fcmDeliveredCount: number;
    message: string;
  }> {
    const { title, body, userId, data } = payload;
    const pool = DatabaseConfig.getPool();

    // 1. Broadcast over live WebSockets if client is active in foreground
    try {
      const wsPayload = {
        id: `notif_${Date.now()}`,
        title,
        body,
        data: data || {},
        type: 'INFO',
        createdAt: new Date().toISOString()
      };

      if (!userId || userId === 'ALL') {
        SocketServer.broadcast('SYSTEM_ANNOUNCEMENT', wsPayload);
      } else {
        SocketServer.emitToUser(userId, 'SYSTEM_ANNOUNCEMENT', wsPayload);
      }
    } catch (e: any) {
      Logger.warn('[PushNotification] WebSocket broadcast warning:', e.message);
    }

    // 2. Fetch target FCM tokens from PostgreSQL database
    let fcmTokens: string[] = [];
    if (pool) {
      try {
        let query = "SELECT fcm_token FROM users WHERE fcm_token IS NOT NULL AND fcm_token != ''";
        const params: any[] = [];
        if (userId && userId !== 'ALL') {
          query += ' AND (id = $1 OR phone = $1)';
          params.push(userId);
        }

        const res = await pool.query(query, params);
        fcmTokens = res.rows.map((r: any) => r.fcm_token).filter(Boolean);
      } catch (e: any) {
        Logger.error('[PushNotification] DB token query failed:', e.message);
      }
    }

    Logger.info(`[PushNotification] Found ${fcmTokens.length} target tokens for notification: "${title}"`);

    // 3. Dispatch real push notification via Firebase Admin SDK
    let fcmSuccessCount = 0;
    const firebaseReady = this.initFirebase();

    if (firebaseReady && this.app && fcmTokens.length > 0) {
      try {
        const messaging = getMessaging(this.app);

        // FCM sendEachForMulticast accepts up to 500 tokens per batch
        const batches: string[][] = [];
        for (let i = 0; i < fcmTokens.length; i += 500) {
          batches.push(fcmTokens.slice(i, i + 500));
        }

        for (const batch of batches) {
          const multicastMessage: MulticastMessage = {
            tokens: batch,
            notification: {
              title,
              body
            },
            data: {
              title,
              body,
              ...(data || {})
            },
            android: {
              priority: 'high',
              notification: {
                title,
                body,
                channelId: 'gameinplay_alerts',
                sound: 'default',
                priority: 'high',
                defaultSound: true,
                defaultVibrateTimings: true
              }
            }
          };

          const response = await messaging.sendEachForMulticast(multicastMessage);

          fcmSuccessCount += response.successCount;
          Logger.info(
            `[PushNotification] FCM batch dispatch: ${response.successCount} succeeded, ${response.failureCount} failed.`
          );

          // Handle any unregistered tokens
          if (response.failureCount > 0 && pool) {
            response.responses.forEach((resp: any, idx: number) => {
              if (!resp.success && resp.error?.code === 'messaging/registration-token-not-registered') {
                const deadToken = batch[idx];
                pool.query('UPDATE users SET fcm_token = NULL WHERE fcm_token = $1', [deadToken]).catch(() => {});
              }
            });
          }
        }
      } catch (fcmErr: any) {
        Logger.error('[PushNotification] Firebase Admin dispatch error:', fcmErr.message);
      }
    }

    return {
      success: true,
      sentCount: fcmTokens.length,
      fcmDeliveredCount: fcmSuccessCount,
      message: `Dispatched to ${fcmTokens.length} devices (FCM Delivered: ${fcmSuccessCount}) and live active players`
    };
  }
}
