import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { envConfig } from './env.config';

let pgPool: Pool | null = null;

export function buildSslConfig(): boolean | { rejectUnauthorized: boolean; ca?: string } {
  const isProduction = envConfig.nodeEnv === 'production';
  const isSupabase = envConfig.databaseUrl.includes('supabase.com');
  const explicitRejectUnauth = process.env.PGSSL_REJECT_UNAUTHORIZED;

  // Resolve custom or built-in CA certificate
  let ca: string | undefined = process.env.PGSSL_CA;
  if (!ca) {
    const customCaPath = process.env.PGSSL_CA_PATH || process.env.PGSSL_CA_FILE;
    if (customCaPath && fs.existsSync(customCaPath)) {
      try {
        ca = fs.readFileSync(customCaPath, 'utf8');
      } catch (err) {
        console.error('❌ Failed to read custom PGSSL_CA_PATH:', err);
      }
    } else if (isSupabase) {
      // Load bundled Supabase Root CA for strict verification
      const candidatePaths = [
        path.join(__dirname, '../../certs/supabase-root-ca.pem'),
        path.join(process.cwd(), 'certs/supabase-root-ca.pem'),
        path.join(process.cwd(), 'backend/certs/supabase-root-ca.pem')
      ];
      const foundPath = candidatePaths.find((p) => fs.existsSync(p));
      if (foundPath) {
        try {
          ca = fs.readFileSync(foundPath, 'utf8');
        } catch (err) {
          console.error('❌ Failed to read bundled Supabase CA certificate:', err);
        }
      }
    }
  }

  // Determine rejectUnauthorized:
  // If explicitly configured, obey it. Otherwise, default to true for CA/production/Supabase.
  const rejectUnauthorized = explicitRejectUnauth !== undefined
    ? explicitRejectUnauth !== 'false'
    : (ca ? true : (isProduction || isSupabase));

  if (isSupabase || isProduction || ca) {
    return {
      rejectUnauthorized,
      ...(ca ? { ca } : {})
    };
  }

  return false;
}

const sslConfig = buildSslConfig();

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
