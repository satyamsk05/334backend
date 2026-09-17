import dotenv from 'dotenv';
import path from 'path';

// Load backend directory .env file
dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config();

const requireEnv = (key: string): string => {
  const val = process.env[key];
  if (!val) {
    console.warn(`[CONFIG WARNING] Environment variable ${key} is not set in backend/.env file.`);
    return '';
  }
  return val;
};

const buildDatabaseUrl = (): string => {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.DB_HOST && process.env.DB_NAME) {
    const user = process.env.DB_USER || 'postgres';
    const pass = process.env.DB_PASSWORD ? `:${process.env.DB_PASSWORD}` : '';
    const host = process.env.DB_HOST || 'localhost';
    const port = process.env.DB_PORT || '5432';
    const db = process.env.DB_NAME;
    return `postgresql://${user}${pass}@${host}:${port}/${db}`;
  }
  return '';
};

export const envConfig = {
  port: parseInt(process.env.PORT || '5050', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  supabaseUrl: requireEnv('SUPABASE_URL'),
  supabaseKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY') || requireEnv('SUPABASE_KEY'),
  databaseUrl: buildDatabaseUrl(),
  redisHost: process.env.REDIS_HOST || '127.0.0.1',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  redisPassword: process.env.REDIS_PASSWORD || '',
  jwtSecret: requireEnv('JWT_SECRET'),
  adminJwtSecret: requireEnv('ADMIN_JWT_SECRET'),
  adminUsername: requireEnv('ADMIN_USERNAME'),
  adminPassword: requireEnv('ADMIN_PASSWORD'),
  telegramBotToken: requireEnv('TELEGRAM_BOT_TOKEN'),
  telegramChatId: requireEnv('TELEGRAM_CHAT_ID'),
  paymentUpiId: requireEnv('PAYMENT_UPI_ID'),
  paymentMerchantName: requireEnv('PAYMENT_MERCHANT_NAME'),
  logginAppKey: requireEnv('LOGGIN_APP_KEY')
};
