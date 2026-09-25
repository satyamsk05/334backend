import { DatabaseConfig } from '../config/db.config';

export class AdminSchema {
  public static async init(): Promise<void> {
    const pool = DatabaseConfig.getPool();
    if (!pool) return;

    const query = `
      -- 1. Admin Notes table
      CREATE TABLE IF NOT EXISTS admin_notes (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        admin_id VARCHAR(64) NOT NULL,
        admin_username VARCHAR(128) NOT NULL,
        note TEXT NOT NULL,
        is_resolved BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_admin_notes_user ON admin_notes(user_id, created_at DESC);

      -- 2. System Settings table
      CREATE TABLE IF NOT EXISTS system_settings (
        key VARCHAR(64) PRIMARY KEY,
        value JSONB NOT NULL DEFAULT '{}'::jsonb,
        description TEXT,
        updated_by VARCHAR(64),
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      -- 3. Announcements table
      CREATE TABLE IF NOT EXISTS announcements (
        id VARCHAR(64) PRIMARY KEY,
        title VARCHAR(256) NOT NULL,
        message TEXT NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
        target_audience VARCHAR(64) DEFAULT 'ALL',
        created_by VARCHAR(64) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      -- 4. Admin Sessions table
      CREATE TABLE IF NOT EXISTS admin_sessions (
        id VARCHAR(64) PRIMARY KEY,
        admin_id VARCHAR(64) NOT NULL,
        username VARCHAR(128) NOT NULL,
        token_hash VARCHAR(128) NOT NULL,
        ip_address VARCHAR(64),
        user_agent TEXT,
        last_activity TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      -- 5. Extend games table with columns if missing
      ALTER TABLE games ADD COLUMN IF NOT EXISTS version VARCHAR(32) DEFAULT '1.0.0';
      ALTER TABLE games ADD COLUMN IF NOT EXISTS display_order INT DEFAULT 0;
      ALTER TABLE games ADD COLUMN IF NOT EXISTS config JSONB DEFAULT '{}'::jsonb;

      -- Seed ring_of_future game if not present
      INSERT INTO games (id, title, status, entry_fee, min_stake, max_stake, version, display_order, config, created_at)
      VALUES (
        'ring_of_future',
        'Ring of Future',
        'LIVE',
        0,
        1000,
        1000000,
        '2.1.0',
        1,
        '{"bettingDurationSec": 15, "resultDurationSec": 5, "maintenance": false}'::jsonb,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (id) DO UPDATE
      SET title = EXCLUDED.title,
          status = EXCLUDED.status;

      -- Seed default system settings
      INSERT INTO system_settings (key, value, description, updated_by, updated_at)
      VALUES
        ('maintenance_mode', '{"enabled": false, "message": "System is under scheduled maintenance"}'::jsonb, 'Platform maintenance mode switch', 'SYSTEM', CURRENT_TIMESTAMP),
        ('app_versions', '{"minVersion": "1.0.0", "latestVersion": "1.0.4", "forceUpdate": false}'::jsonb, 'Client app version control', 'SYSTEM', CURRENT_TIMESTAMP),
        ('operational_flags', '{"depositsEnabled": true, "withdrawalsEnabled": true, "betsEnabled": true}'::jsonb, 'Operational circuit breakers', 'SYSTEM', CURRENT_TIMESTAMP)
      ON CONFLICT (key) DO NOTHING;
    `;

    try {
      await pool.query(query);
      console.log('✅ Admin schema tables & seeds verified.');
    } catch (err) {
      console.error('❌ Failed to initialize admin schema tables:', err);
    }
  }
}
