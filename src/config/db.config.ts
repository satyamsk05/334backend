import { Pool } from 'pg';
import { envConfig } from './env.config';

let pgPool: Pool | null = null;

const isProduction = envConfig.nodeEnv === 'production';
const rejectUnauthorized = process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false';
const isSupabase = envConfig.databaseUrl.includes('supabase.com');
const sslConfig = isSupabase
  ? { rejectUnauthorized: false }
  : (isProduction ? { rejectUnauthorized } : false);

export class DatabaseConfig {
  public static getPool(): Pool | null {
    if (!pgPool && envConfig.databaseUrl) {
      try {
        pgPool = new Pool({
          connectionString: envConfig.databaseUrl,
          ssl: sslConfig,
          max: Number(process.env.DB_POOL_MAX || 10),
          idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
          connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10000)
        });

        pgPool.on('error', (err) => {
          console.error('Unexpected PostgreSQL pool error:', err);
        });

        console.log('✅ PostgreSQL connection pool initialized');
      } catch (err) {
        console.error('❌ PostgreSQL pool initialization failed:', err);
        pgPool = null;
      }
    }
    return pgPool;
  }

  public static isConnected(): boolean {
    return pgPool !== null;
  }

  public static async checkHealth(): Promise<boolean> {
    const pool = this.getPool();

    if (!pool) {
      return false;
    }

    try {
      await pool.query('SELECT 1');
      return true;
    } catch (err) {
      console.error('❌ PostgreSQL health check failed:', err);
      return false;
    }
  }

  public static async close(): Promise<void> {
    if (!pgPool) return;

    const pool = pgPool;
    pgPool = null;
    await pool.end();
    console.log('✅ PostgreSQL connection pool closed');
  }
}
