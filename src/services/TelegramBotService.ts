import https from 'https';
import { config } from '../config/env';

export class TelegramBotService {
  public static async sendAlert(message: string): Promise<boolean> {
    if (!config.telegramAlertsEnabled || !config.telegramBotToken || !config.telegramChatId) {
      return false;
    }

    const payload = JSON.stringify({
      chat_id: config.telegramChatId,
      text: `🤖 *334Game Server Alert*\n\n${message}`,
      parse_mode: 'Markdown'
    });

    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${config.telegramBotToken}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    return new Promise((resolve) => {
      const req = https.request(options, (res) => {
        resolve(res.statusCode === 200);
      });

      req.on('error', (err) => {
        console.error('❌ Telegram Bot Alert Error:', err.message);
        resolve(false);
      });

      req.write(payload);
      req.end();
    });
  }
}
