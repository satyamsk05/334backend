import Redis from 'ioredis';
import { envConfig } from './env.config';

export class RedisConfig {
  private static client: Redis | null = null;
  private static initialized = false;
  private static readonly memoryStore = new Map<string, string>();

  private static getClient(): Redis | null {
    if (RedisConfig.initialized) return RedisConfig.client;

    RedisConfig.initialized = true;

    try {
      RedisConfig.client = new Redis({
        host: envConfig.redisHost,
        port: envConfig.redisPort,
        password: envConfig.redisPassword || undefined,
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 2,
        connectTimeout: 5000,
        retryStrategy: (times) => Math.min(times * 250, 3000)
      });

      RedisConfig.client.on('error', (error) => {
        console.error('[REDIS] Connection error:', error.message);
      });

      RedisConfig.client.on('connect', () => {
        console.log('[REDIS] Connected');
      });

      RedisConfig.client.on('close', () => {
        console.warn('[REDIS] Connection closed');
      });

      return RedisConfig.client;
    } catch (error) {
      console.error('[REDIS] Initialization failed:', error);
      RedisConfig.client = null;
      return null;
    }
  }

  public static async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const client = RedisConfig.getClient();

    if (client) {
      if (client.status === 'wait') await client.connect();
      if (ttlSeconds && ttlSeconds > 0) {
        await client.set(key, value, 'EX', ttlSeconds);
      } else {
        await client.set(key, value);
      }
      return;
    }

    if (envConfig.nodeEnv === 'production') {
      throw new Error('Redis is unavailable in production');
    }

    RedisConfig.memoryStore.set(key, value);
  }

  public static async get(key: string): Promise<string | null> {
    const client = RedisConfig.getClient();

    if (client) {
      if (client.status === 'wait') await client.connect();
      return (await client.get(key)) || null;
    }

    if (envConfig.nodeEnv === 'production') {
      throw new Error('Redis is unavailable in production');
    }

    return RedisConfig.memoryStore.get(key) || null;
  }

  public static async del(key: string): Promise<void> {
    const client = RedisConfig.getClient();

    if (client) {
      if (client.status === 'wait') await client.connect();
      await client.del(key);
      return;
    }

    if (envConfig.nodeEnv === 'production') {
      throw new Error('Redis is unavailable in production');
    }

    RedisConfig.memoryStore.delete(key);
  }

  public static async close(): Promise<void> {
    if (RedisConfig.client && RedisConfig.client.status !== 'end') {
      await RedisConfig.client.quit();
    }
    RedisConfig.client = null;
    RedisConfig.initialized = false;
  }
}
