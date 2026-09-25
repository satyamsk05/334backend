import { DatabaseConfig } from '../config/db.config';
import { Logger } from '../utils/logger';

export interface AuditEntry {
  adminId: string;
  action: string;
  target?: string;
  userId?: string;
  ipAddress?: string;
  details?: Record<string, any>;
}

export class AuditService {
  public static async log(entry: AuditEntry): Promise<void> {
    const pool = DatabaseConfig.getPool();
    if (!pool) return;

    const auditId = `aud_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    try {
      await pool.query(
        `INSERT INTO audit_logs (id, admin_id, action, target, user_id, ip_address, details, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)`,
        [
          auditId,
          entry.adminId || 'SYSTEM',
          entry.action,
          entry.target || null,
          entry.userId || null,
          entry.ipAddress || null,
          JSON.stringify(entry.details || {})
        ]
      );
      Logger.info(`[AUDIT] Action: ${entry.action} by ${entry.adminId} on ${entry.target || 'N/A'}`);
    } catch (err) {
      Logger.error(`[AUDIT ERROR] Failed to record audit log:`, err);
    }
  }

  public static async getLogs(limit: number = 100, actionFilter?: string): Promise<any[]> {
    const pool = DatabaseConfig.getPool();
    if (!pool) return [];

    let query = `
      SELECT id, admin_id, action, target, user_id, ip_address, details, created_at
      FROM audit_logs
    `;
    const params: any[] = [];

    if (actionFilter) {
      query += ` WHERE action = $1`;
      params.push(actionFilter);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const res = await pool.query(query, params);
    return res.rows.map((r: any) => ({
      ...r,
      details: typeof r.details === 'string' ? JSON.parse(r.details) : (r.details || {})
    }));
  }
}
