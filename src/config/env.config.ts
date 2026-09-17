import dotenv from 'dotenv';
import path from 'path';

// Load backend directory .env file first, then fallback to process cwd.
dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config();

const isProduction = (process.env.NODE_ENV || 'development') === 'production';

const readEnv = (key: string): string => process.env[key]?.trim() || '';

const requireProductionEnv = (key: string): string => {
  const value = readEnv(key);

  if (isProduction && !value) {
    throw new Error(`[CONFIG ERROR] Required production environment variable is missing: ${key}`);
  }

  if (!value) {
    console.warn(`[CONFIG WARNING] Environment variable ${key} is not set.`);
  }

  return value;
};

const buildDatabaseUrl = (): string => {
  const directUrl = readEnv('DATABASE_URL');
  if (directUrl) return directUrl;

  const host = readEnv('DB_HOST');
  const database = readEnv('DB_NAME');

  if (host && database) {
    const user = readEnv('DB_USER') || 'postgres';
    const password = readEnv('DB_PASSWORD');
    const port = readEnv('DB_PORT') || '5432';
    const encodedUser = encodeURIComponent(user);
    const encodedPassword = password ? `:${encodeURIComponent(password)}` : '';

    return `postgresql://${encodedUser}${encodedPassword}@${host}:${port}/${database}`;
  }

  return '';
};

const port = Number.parseInt(process.env.PORT || '5050', 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('[CONFIG ERROR] PORT must be an integer between 1 and 65535.');
}

export const envConfig = {
  port,
  nodeEnv: process.env.NODE_ENV || 'development',
  supabaseUrl: requireProductionEnv('SUPABASE_URL'),
  supabaseKey: requireProductionEnv('SUPABASE_SERVICE_ROLE_KEY') || requireProductionEnv('SUPABASE_KEY'),
  databaseUrl: buildDatabaseUrl(),
  redisHost: process.env.REDIS_HOST || '127.0.0.1',
  redisPort: Number.parseInt(process.env.REDIS_PORT || '6379', 10),
  redisPassword: process.env.REDIS_PASSWORD || '',
  jwtSecret: requireProductionEnv('JWT_SECRET'),
  adminJwtSecret: requireProductionEnv('ADMIN_JWT_SECRET'),
  adminUsername: requireProductionEnv('ADMIN_USERNAME'),
  adminPassword: requireProductionEnv('ADMIN_PASSWORD'),
  telegramBotToken: requireProductionEnv('TELEGRAM_BOT_TOKEN'),
  telegramChatId: requireProductionEnv('TELEGRAM_CHAT_ID'),
  paymentUpiId: requireProductionEnv('PAYMENT_UPI_ID'),
  paymentMerchantName: requireProductionEnv('PAYMENT_MERCHANT_NAME'),
  logginAppKey: requireProductionEnv('LOGGIN_APP_KEY')
};

if (isProduction && !envConfig.databaseUrl) {
  throw new Error('[CONFIG ERROR] DATABASE_URL or DB_HOST + DB_NAME is required in production.');
}

if (isProduction && envConfig.jwtSecret.length < 32) {
  throw new Error('[CONFIG ERROR] JWT_SECRET must contain at least 32 characters in production.');
}

if (isProduction && envConfig.adminJwtSecret.length < 32) {
  throw new Error('[CONFIG ERROR] ADMIN_JWT_SECRET must contain at least 32 characters in production.');
}
