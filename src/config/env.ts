import dotenv from 'dotenv';
import path from 'path';

// Load .env from root project directory or local backend directory
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  supabaseDbUrl: process.env.SUPABASE_DB_URL || '',
  jwtSecret: process.env.JWT_SECRET || '',
  adminSecretKey: process.env.ADMIN_SECRET_KEY || process.env.ADMIN_PASSWORD || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  telegramAlertsEnabled: process.env.TELEGRAM_ALERTS_ENABLED === 'true',
  rtpTargetPercent: parseFloat(process.env.RTP_TARGET_PERCENT || '95.0'),
  betMinLimitRupees: parseFloat(process.env.BET_MIN_LIMIT || '10.0'),
  betMaxLimitRupees: parseFloat(process.env.BET_MAX_LIMIT || '10000.0'),
};
