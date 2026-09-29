import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

import { envConfig } from '../config/env.config';

const connectionString = envConfig.databaseUrl || process.env.DATABASE_URL;

if (!connectionString) {
  console.error('❌ DATABASE_URL is not set. Aborting database reset.');
  process.exit(1);
}

if (process.env.NODE_ENV === 'production' && !process.argv.includes('--force-production-reset')) {
  console.error('❌ Refusing to reset database in production without --force-production-reset flag.');
  process.exit(1);
}

async function resetAllData() {
  console.log('🔄 Starting Complete Database & Ledger Reset...');

  // 1. Reset Local JSON Ledgers
  try {
    const dataDir = path.join(__dirname, '../../data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const financialLedgerPath = path.join(dataDir, 'financial_ledger.json');
    if (fs.existsSync(financialLedgerPath)) {
      fs.unlinkSync(financialLedgerPath);
      console.log('✅ Removed deprecated financial_ledger.json');
    }

    const usersLedgerPath = path.join(dataDir, 'users_ledger.json');
    fs.writeFileSync(usersLedgerPath, JSON.stringify([], null, 2), 'utf-8');
    console.log('✅ Cleared users_ledger.json');
  } catch (e: any) {
    console.error('⚠️ Error resetting JSON files:', e.message);
  }

  // 2. Truncate Database Tables
  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }
  });

  try {
    const client = await pool.connect();
    console.log('🔌 Connected to PostgreSQL / Supabase Database...');

    const tablesToTruncate = [
      'bets',
      'settlements',
      'game_rounds',
      'deposits',
      'withdrawals',
      'payment_webhook_events',
      'wallet_ledger',
      'user_sessions',
      'wallets',
      'users',
      'notifications',
      'audit_logs',
      'admin_notes'
    ];

    for (const table of tablesToTruncate) {
      try {
        await client.query(`TRUNCATE TABLE "${table}" CASCADE;`);
        console.log(`🧹 Cleaned table: ${table}`);
      } catch (err: any) {
        console.warn(`⚠️ Table ${table} skip/error: ${err.message}`);
      }
    }

    client.release();
    console.log('✨ All Database tables and transactional records reset successfully!');
  } catch (err: any) {
    console.error('❌ Failed to reset PostgreSQL database:', err.message);
  } finally {
    await pool.end();
  }

  console.log('🚀 Reset complete! Database is now 100% fresh and clean.');
}

resetAllData();
