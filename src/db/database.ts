import { Pool } from 'pg';
import { config } from '../config/env';

export class Database {
  private static pool: Pool | null = null;
  private static isMemoryFallback = false;

  public static async init(): Promise<void> {
    if (!config.supabaseDbUrl) {
      console.warn('⚠️ SUPABASE_DB_URL not found in .env. Running database in-memory mode.');
      Database.isMemoryFallback = true;
      return;
    }

    try {
      Database.pool = new Pool({
        connectionString: config.supabaseDbUrl,
        ssl: config.supabaseDbUrl.includes('supabase.com') ? { rejectUnauthorized: false } : false,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });

      // Test connection
      const client = await Database.pool.connect();
      console.log('✅ Connected to PostgreSQL / Supabase Database Pool successfully!');
      client.release();

      await Database.createTablesIfNotExist();
    } catch (err) {
      console.error('❌ Database connection error:', err);
      console.warn('⚠️ Falling back to in-memory store for server operation.');
      Database.isMemoryFallback = true;
    }
  }

  private static async createTablesIfNotExist(): Promise<void> {
    if (!Database.pool) return;

    const schemaQuery = `
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(64) PRIMARY KEY,
        username VARCHAR(128) NOT NULL,
        phone VARCHAR(32) NOT NULL,
        avatar_res_id INT DEFAULT 0,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS wallet_balances (
        user_id VARCHAR(64) PRIMARY KEY REFERENCES users(id),
        deposit_paise BIGINT DEFAULT 50000,
        winning_paise BIGINT DEFAULT 125000,
        bonus_paise BIGINT DEFAULT 10000,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        type VARCHAR(32) NOT NULL,
        amount_paise BIGINT NOT NULL,
        balance_after_paise BIGINT NOT NULL,
        status VARCHAR(32) NOT NULL,
        reference_id VARCHAR(128) NOT NULL,
        description TEXT NOT NULL,
        timestamp BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS game_rounds (
        id VARCHAR(64) PRIMARY KEY,
        sequence_number BIGINT NOT NULL,
        phase VARCHAR(32) NOT NULL,
        winning_segment_index INT,
        betting_open_at BIGINT NOT NULL,
        betting_close_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bets (
        id VARCHAR(64) PRIMARY KEY,
        round_id VARCHAR(64) NOT NULL,
        user_id VARCHAR(64) NOT NULL,
        color_type VARCHAR(32) NOT NULL,
        amount_paise BIGINT NOT NULL,
        deposit_debited BIGINT NOT NULL,
        winning_debited BIGINT NOT NULL,
        bonus_debited BIGINT NOT NULL,
        created_at BIGINT NOT NULL
      );
    `;

    try {
      await Database.pool.query(schemaQuery);
      console.log('✅ Database tables initialized successfully.');
    } catch (error) {
      console.error('❌ Failed to initialize database schema:', error);
    }
  }

  public static getPool(): Pool | null {
    return Database.pool;
  }

  public static isMemory(): boolean {
    return Database.isMemoryFallback;
  }
}
