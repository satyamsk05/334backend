import crypto from 'crypto';
import { RedisManager } from '../db/redis';

export type PageAccessPurpose = 'pay' | 'game';

export interface PageAccessPayload {
  userId: string;
  purpose: PageAccessPurpose;
  amountRupees?: number;
  orderId?: string;
  createdAt: number;
}

/**
 * Short-lived opaque tickets for browser/WebView page access.
 * Keeps long-lived session JWTs out of URLs, history, and Referer headers.
 */
export class PageAccessTicket {
  private static key(ticket: string): string {
    return `page_access:${ticket}`;
  }

  public static async issue(
    userId: string,
    purpose: PageAccessPurpose,
    meta: { amountRupees?: number; orderId?: string } = {},
    ttlSeconds = 300
  ): Promise<string> {
    const ticket = crypto.randomBytes(24).toString('base64url');
    const payload: PageAccessPayload = {
      userId,
      purpose,
      amountRupees: meta.amountRupees,
      orderId: meta.orderId,
      createdAt: Date.now(),
    };
    await RedisManager.set(PageAccessTicket.key(ticket), JSON.stringify(payload), ttlSeconds);
    return ticket;
  }

  public static async resolve(
    ticket: string | undefined | null,
    purpose: PageAccessPurpose
  ): Promise<PageAccessPayload | null> {
    if (!ticket || !/^[A-Za-z0-9_-]{16,128}$/.test(ticket)) {
      return null;
    }
    try {
      const raw = await RedisManager.get(PageAccessTicket.key(ticket));
      if (!raw) return null;
      const payload = JSON.parse(raw) as PageAccessPayload;
      if (!payload?.userId || payload.purpose !== purpose) return null;
      return payload;
    } catch {
      return null;
    }
  }
}
