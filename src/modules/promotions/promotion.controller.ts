import { Request, Response } from 'express';
import { DatabaseConfig } from '../../config/db.config';
import { ResponseHandler } from '../../utils/responseHandler';
import { AuditService } from '../../services/AuditService';

export class PromotionController {
  private static async ensureTable() {
    const pool = DatabaseConfig.getPool();
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS promotions (
        id VARCHAR(64) PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        subtitle VARCHAR(255) NOT NULL,
        badge_text VARCHAR(64),
        cta_text VARCHAR(64) DEFAULT 'PLAY NOW',
        target_route VARCHAR(128) DEFAULT '/games',
        gradient_start VARCHAR(32) DEFAULT '#8B5CF6',
        gradient_end VARCHAR(32) DEFAULT '#6D28D9',
        icon_type VARCHAR(64) DEFAULT 'welcome',
        image_url TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        display_order INT DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE promotions ADD COLUMN IF NOT EXISTS badge_text VARCHAR(64);
      ALTER TABLE promotions ADD COLUMN IF NOT EXISTS cta_text VARCHAR(64) DEFAULT 'PLAY NOW';
      ALTER TABLE promotions ADD COLUMN IF NOT EXISTS target_route VARCHAR(128) DEFAULT '/games';
      ALTER TABLE promotions ADD COLUMN IF NOT EXISTS gradient_start VARCHAR(32) DEFAULT '#8B5CF6';
      ALTER TABLE promotions ADD COLUMN IF NOT EXISTS gradient_end VARCHAR(32) DEFAULT '#6D28D9';
      ALTER TABLE promotions ADD COLUMN IF NOT EXISTS icon_type VARCHAR(64) DEFAULT 'welcome';
      ALTER TABLE promotions ADD COLUMN IF NOT EXISTS image_url TEXT;
      ALTER TABLE promotions ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
      ALTER TABLE promotions ADD COLUMN IF NOT EXISTS display_order INT DEFAULT 1;
    `);

    const countRes = await pool.query('SELECT COUNT(*) as count FROM promotions');
    if (parseInt(countRes.rows[0]?.count || '0', 10) === 0) {
      const seedBanners = [
        {
          id: 'promo_welcome',
          title: 'WELCOME BONUS',
          subtitle: 'Claim 100% instant cash boost on your first deposit!',
          badge_text: 'HOT',
          cta_text: 'ADD CASH',
          target_route: '/wallet/deposit',
          gradient_start: '#5B1FA6',
          gradient_end: '#3B0764',
          icon_type: 'welcome',
          display_order: 1
        },
        {
          id: 'promo_xo_battle',
          title: '1v1 XO BATTLE',
          subtitle: 'Play Live Tic-Tac-Toe battles with real cash prizes!',
          badge_text: 'LIVE',
          cta_text: 'PLAY NOW',
          target_route: '/games/xo',
          gradient_start: '#6D28D9',
          gradient_end: '#2E1065',
          icon_type: 'xo',
          display_order: 2
        },
        {
          id: 'promo_ring_future',
          title: 'RING OF FUTURE',
          subtitle: 'Spin the 32-segment wheel for up to 30x instant multiplier!',
          badge_text: 'NEW',
          cta_text: 'PLAY NOW',
          target_route: '/games/ring',
          gradient_start: '#0F766E',
          gradient_end: '#042F2E',
          icon_type: 'ring',
          display_order: 3
        },
        {
          id: 'promo_instant_cashout',
          title: 'INSTANT CASHOUT',
          subtitle: '24/7 lightning fast UPI withdrawals directly to your bank account.',
          badge_text: 'VIP',
          cta_text: 'WITHDRAW',
          target_route: '/wallet/withdraw',
          gradient_start: '#9D174D',
          gradient_end: '#500724',
          icon_type: 'wallet',
          display_order: 4
        }
      ];

      for (const b of seedBanners) {
        await pool.query(
          `INSERT INTO promotions (id, title, subtitle, badge_text, cta_text, target_route, gradient_start, gradient_end, icon_type, display_order, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
           ON CONFLICT (id) DO NOTHING`,
          [b.id, b.title, b.subtitle, b.badge_text, b.cta_text, b.target_route, b.gradient_start, b.gradient_end, b.icon_type, b.display_order]
        );
      }
    }
  }

  /**
   * Public endpoint for Mobile App to fetch active promotions
   * GET /api/v1/promotions or GET /api/v1/promotions/active
   */
  public static async getActivePromotions(_req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    try {
      await PromotionController.ensureTable();
      const result = await pool.query(
        'SELECT * FROM promotions WHERE is_active = TRUE ORDER BY display_order ASC, created_at DESC'
      );
      return ResponseHandler.success(res, result.rows, 'Active promotions retrieved');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  /**
   * Admin endpoint to get all promotions (active & inactive)
   * GET /api/v1/admin/promotions
   */
  public static async getAllPromotions(_req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    try {
      await PromotionController.ensureTable();
      const result = await pool.query(
        'SELECT * FROM promotions ORDER BY display_order ASC, created_at DESC'
      );
      return ResponseHandler.success(res, result.rows, 'All promotions retrieved');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  /**
   * Admin endpoint to create a new promotion
   * POST /api/v1/admin/promotions
   */
  public static async createPromotion(req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    const {
      title,
      subtitle,
      badgeText = 'HOT',
      ctaText = 'PLAY NOW',
      targetRoute = '/games/xo',
      gradientStart = '#8B5CF6',
      gradientEnd = '#6D28D9',
      iconType = 'welcome',
      imageUrl = null,
      displayOrder = 1
    } = req.body;

    const admin = (req as any).admin || { username: 'ADMIN' };

    if (!title || !subtitle) {
      return ResponseHandler.error(res, 'Title and subtitle are required', 400);
    }

    const id = `promo_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    try {
      await PromotionController.ensureTable();
      await pool.query(
        `INSERT INTO promotions (id, title, subtitle, badge_text, cta_text, target_route, gradient_start, gradient_end, icon_type, image_url, display_order, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [id, title.trim(), subtitle.trim(), badgeText.trim(), ctaText.trim(), targetRoute.trim(), gradientStart, gradientEnd, iconType, imageUrl, displayOrder]
      );

      await AuditService.log({
        adminId: admin.username,
        action: 'PROMOTION_CREATED',
        target: `promo:${id}`,
        details: { title, badgeText, targetRoute, iconType }
      });

      return ResponseHandler.success(res, { id }, 'Promotion created successfully');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  /**
   * Admin endpoint to update an existing promotion
   * PUT /api/v1/admin/promotions/:id
   */
  public static async updatePromotion(req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    const id = req.params.id;
    const {
      title,
      subtitle,
      badgeText,
      ctaText,
      targetRoute,
      gradientStart,
      gradientEnd,
      iconType,
      imageUrl,
      displayOrder,
      isActive
    } = req.body;

    const admin = (req as any).admin || { username: 'ADMIN' };

    try {
      await PromotionController.ensureTable();
      const existing = await pool.query('SELECT * FROM promotions WHERE id = $1', [id]);
      if (existing.rows.length === 0) {
        return ResponseHandler.error(res, 'Promotion not found', 404);
      }

      const current = existing.rows[0];

      await pool.query(
        `UPDATE promotions SET
          title = $1,
          subtitle = $2,
          badge_text = $3,
          cta_text = $4,
          target_route = $5,
          gradient_start = $6,
          gradient_end = $7,
          icon_type = $8,
          image_url = $9,
          display_order = $10,
          is_active = $11,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = $12`,
        [
          title !== undefined ? title.trim() : current.title,
          subtitle !== undefined ? subtitle.trim() : current.subtitle,
          badgeText !== undefined ? badgeText.trim() : current.badge_text,
          ctaText !== undefined ? ctaText.trim() : current.cta_text,
          targetRoute !== undefined ? targetRoute.trim() : current.target_route,
          gradientStart !== undefined ? gradientStart : current.gradient_start,
          gradientEnd !== undefined ? gradientEnd : current.gradient_end,
          iconType !== undefined ? iconType : current.icon_type,
          imageUrl !== undefined ? imageUrl : current.image_url,
          displayOrder !== undefined ? parseInt(displayOrder, 10) : current.display_order,
          isActive !== undefined ? Boolean(isActive) : current.is_active,
          id
        ]
      );

      await AuditService.log({
        adminId: admin.username,
        action: 'PROMOTION_UPDATED',
        target: `promo:${id}`,
        details: { title, targetRoute, isActive }
      });

      return ResponseHandler.success(res, { id }, 'Promotion updated successfully');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  /**
   * Admin endpoint to toggle promotion active status
   * PATCH /api/v1/admin/promotions/:id/status
   */
  public static async togglePromotionStatus(req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    const id = req.params.id;
    const { isActive } = req.body;
    const admin = (req as any).admin || { username: 'ADMIN' };

    try {
      await pool.query('UPDATE promotions SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [Boolean(isActive), id]);

      await AuditService.log({
        adminId: admin.username,
        action: 'PROMOTION_STATUS_CHANGED',
        target: `promo:${id}`,
        details: { isActive }
      });

      return ResponseHandler.success(res, { id, isActive }, `Promotion is now ${isActive ? 'ACTIVE' : 'INACTIVE'}`);
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  /**
   * Admin endpoint to delete a promotion
   * DELETE /api/v1/admin/promotions/:id
   */
  public static async deletePromotion(req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    const id = req.params.id;
    const admin = (req as any).admin || { username: 'ADMIN' };

    try {
      await pool.query('DELETE FROM promotions WHERE id = $1', [id]);

      await AuditService.log({
        adminId: admin.username,
        action: 'PROMOTION_DELETED',
        target: `promo:${id}`
      });

      return ResponseHandler.success(res, { id }, 'Promotion banner deleted successfully');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }
}
