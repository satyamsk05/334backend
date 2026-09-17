import { Pool } from 'pg';
import { envConfig } from './env.config';

let pgPool: Pool | null = null;

export class DatabaseConfig {
  public static getPool(): Pool | null {
    if (!pgPool && envConfig.databaseUrl) {
      try {
        pgPool = new Pool({
          connectionString: envConfig.databaseUrl,
          ssl: envConfig.nodeEnv === 'production' ? { rejectUnauthorized: false } : false
        });
        console.log('✅ PostgreSQL connection pool initialized');
      } catch (err) {
        console.warn('⚠️ Postgres connection failed:', err);
      }
    }
    return pgPool;
  }

  public static isConnected(): boolean {
    return pgPool !== null;
  }
}
