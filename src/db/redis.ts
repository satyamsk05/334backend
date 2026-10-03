import EventEmitter from 'events';
import Redis from 'ioredis';

export class RedisManager {
  private static client: Redis | null = null;
  private static subClient: Redis | null = null;
  private static isConnected = false;
  private static fallbackMap = new Map<string, string>();
  private static localEmitter = new EventEmitter();
  private static subscribedChannels = new Set<string>();

  public static init(): void {
    const host = process.env.REDIS_HOST || '127.0.0.1';
    const port = process.env.REDIS_PORT || '6379';
    const auth = process.env.REDIS_PASSWORD ? `:${encodeURIComponent(process.env.REDIS_PASSWORD)}@` : '';
    const redisUrl = process.env.REDIS_URL || `redis://${auth}${host}:${port}`;

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

      RedisManager.subClient = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        retryStrategy(times) {
          if (times > 3) {
            return null;
          }
          return Math.min(times * 200, 1000);
        }
      });

      RedisManager.client.on('connect', () => {
        RedisManager.isConnected = true;
        console.log('⚡ Redis Connected Successfully (Local/EC2 Redis instance)');
      });

      RedisManager.subClient.on('message', (channel, message) => {
        RedisManager.localEmitter.emit(channel, message);
      });

      RedisManager.client.on('error', (err) => {
        if (RedisManager.isConnected) {
          console.warn('⚠️ Redis Connection Error:', err.message);
        }
        RedisManager.isConnected = false;
      });

      RedisManager.subClient.on('error', () => {
        // Silently handled by local emitter fallback
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

  public static async incr(key: string): Promise<number> {
    if (RedisManager.isReady()) {
      try {
        return await RedisManager.client!.incr(key);
      } catch (e) {
        // Fallback
      }
    }
    const current = parseInt(RedisManager.fallbackMap.get(key) || '0', 10);
    const nextVal = (isNaN(current) ? 0 : current) + 1;
    RedisManager.fallbackMap.set(key, nextVal.toString());
    return nextVal;
  }

  public static async expire(key: string, ttlSeconds: number): Promise<boolean> {
    if (RedisManager.isReady()) {
      try {
        const res = await RedisManager.client!.expire(key, ttlSeconds);
        return res === 1;
      } catch (e) {
        // Fallback
      }
    }
    if (RedisManager.fallbackMap.has(key)) {
      setTimeout(() => {
        RedisManager.fallbackMap.delete(key);
      }, ttlSeconds * 1000).unref();
      return true;
    }
    return false;
  }

  public static async ttl(key: string): Promise<number> {
    if (RedisManager.isReady()) {
      try {
        return await RedisManager.client!.ttl(key);
      } catch (e) {
        // Fallback
      }
    }
    return -1;
  }

  public static async publish(channel: string, message: string): Promise<void> {
    if (RedisManager.isReady()) {
      try {
        await RedisManager.client!.publish(channel, message);
        return;
      } catch (e) {
        // Fallback to local emitter
      }
    }
    RedisManager.localEmitter.emit(channel, message);
  }

  public static subscribe(channel: string, listener: (message: string) => void): void {
    RedisManager.localEmitter.on(channel, listener);

    if (RedisManager.subClient && !RedisManager.subscribedChannels.has(channel)) {
      RedisManager.subscribedChannels.add(channel);
      RedisManager.subClient.subscribe(channel).catch(() => {});
    }
  }

  public static unsubscribe(channel: string, listener: (message: string) => void): void {
    RedisManager.localEmitter.off(channel, listener);
  }
}
