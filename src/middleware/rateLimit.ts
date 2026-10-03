import { Request, Response, NextFunction } from 'express';
import { RedisManager } from '../db/redis';

/**
 * Distributed Redis-backed Rate Limiter with memory fallback.
 * Works uniformly across PM2 clusters, Docker containers, and multi-instance deployments.
 */
export function createRateLimiter(windowMs: number, maxRequests: number, prefix: string = 'rl') {
  const windowSec = Math.max(1, Math.ceil(windowMs / 1000));

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ip = (req.ip || req.socket.remoteAddress || 'unknown').trim();
      const key = `${prefix}:${ip}`;

      const count = await RedisManager.incr(key);
      if (count === 1) {
        await RedisManager.expire(key, windowSec);
      }

      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - count));

      if (count > maxRequests) {
        let ttl = await RedisManager.ttl(key);
        if (ttl <= 0) ttl = windowSec;
        res.setHeader('Retry-After', ttl);
        res.status(429).json({ error: 'Too many requests. Please try again later.' });
        return;
      }

      next();
    } catch {
      // In case of any rate limiting error, fail-open to preserve API availability
      next();
    }
  };
}

/**
 * Dedicated brute-force protection for admin login:
 * Max 5 attempts per IP per 15 minutes.
 * Significantly stricter than the general authRateLimit (20 req/min).
 */
export const adminLoginRateLimit = createRateLimiter(15 * 60_000, 5, 'rl:admin_login');
