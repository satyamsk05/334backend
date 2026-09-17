import Redis from 'ioredis';

export class RedisManager {
  private static client: Redis | null = null;
  private static isConnected = false;
  private static fallbackMap = new Map<string, string>();

  public static init(): void {
    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

    try {
      RedisManager.client = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        retryStrategy(times) {
          if (times > 3) {
            return null; // Stop retrying, use in-memory fallback
          }
          return Math.min(times * 200, 1000);
        }
      });

      RedisManager.client.on('connect', () => {
        RedisManager.isConnected = true;
        console.log('⚡ Redis Connected Successfully (Local/EC2 Redis instance)');
      });

      RedisManager.client.on('error', (err) => {
        if (RedisManager.isConnected) {
          console.warn('⚠️ Redis Connection Error:', err.message);
        }
        RedisManager.isConnected = false;
      });
    } catch (err) {
      console.warn('⚠️ Redis Init Warning (Using In-Memory Fallback):', err);
      RedisManager.isConnected = false;
    }
  }

  public static isReady(): boolean {
    return RedisManager.isConnected && RedisManager.client !== null;
  }

  public static async get(key: string): Promise<string | null> {
    if (RedisManager.isReady()) {
      try {
        return await RedisManager.client!.get(key);
      } catch (e) {
        // Fallback
      }
    }
    return RedisManager.fallbackMap.get(key) || null;
  }

  public static async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (RedisManager.isReady()) {
      try {
        if (ttlSeconds) {
          await RedisManager.client!.setex(key, ttlSeconds, value);
        } else {
          await RedisManager.client!.set(key, value);
        }
        return;
      } catch (e) {
        // Fallback
      }
    }

    RedisManager.fallbackMap.set(key, value);
    if (ttlSeconds) {
      setTimeout(() => {
        RedisManager.fallbackMap.delete(key);
      }, ttlSeconds * 1000);
    }
  }

  public static async del(key: string): Promise<void> {
    if (RedisManager.isReady()) {
      try {
        await RedisManager.client!.del(key);
        return;
      } catch (e) {
        // Fallback
      }
    }
    RedisManager.fallbackMap.delete(key);
  }
}
