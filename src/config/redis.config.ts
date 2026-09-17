import { envConfig } from './env.config';

export class RedisConfig {
  private static memoryStore = new Map<string, string>();

  public static async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    RedisConfig.memoryStore.set(key, value);
    if (ttlSeconds) {
      setTimeout(() => {
        RedisConfig.memoryStore.delete(key);
      }, ttlSeconds * 1000);
    }
  }

  public static async get(key: string): Promise<string | null> {
    return RedisConfig.memoryStore.get(key) || null;
  }

  public static async del(key: string): Promise<void> {
    RedisConfig.memoryStore.delete(key);
  }
}
