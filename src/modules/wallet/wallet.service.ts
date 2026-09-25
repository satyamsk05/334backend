import { Pool, PoolClient } from 'pg';
import { DatabaseConfig } from '../../config/db.config';
import { Transaction } from '../../database/models/Transaction';
import { Logger } from '../../utils/logger';

export interface WalletBalanceState {
  depositPaise: number;
  winningPaise: number;
  bonusPaise: number;
  totalPaise: number;
}

export interface DebitResult {
  success: boolean;
  message?: string;
  debitBreakdown?: {
    depositDebited: number;
    winningDebited: number;
    bonusDebited: number;
  };
  newBalance?: WalletBalanceState;
}

interface WalletRow {
  id: string;
  user_id: string;
  available_balance: string;
  deposit_balance: string;
  winnings_balance: string;
  rewards_balance: string;
  reserved_balance: string;
  locked_balance: string;
  version: string;
}

export class WalletService {
  private static getPool(): Pool {
    const pool = DatabaseConfig.getPool();
    if (!pool) {
      throw new Error('[WALLET] Database connection pool is not available.');
    }
    return pool;
  }

  /**
   * Ensures that a user record exists in `users` and a wallet row exists in `wallets`.
   * Both are initialized idempotently.
   */
  public static async ensureWallet(clientOrPool: Pool | PoolClient, userId: string): Promise<WalletRow> {
    // 1. Ensure user row exists so foreign key references succeed
    await clientOrPool.query(
      `INSERT INTO users (id, username, created_at, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO NOTHING`,
      [userId, `Player_${userId.slice(-4)}`]
    );

    // 2. Ensure wallet row exists
    const walletId = `wlt_${userId}`;
    await clientOrPool.query(
      `INSERT INTO wallets (
         id, user_id, available_balance, deposit_balance, winnings_balance,
         rewards_balance, reserved_balance, locked_balance, version,
         created_at, updated_at
       )
       VALUES ($1, $2, 0, 0, 0, 0, 0, 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) DO NOTHING`,
      [walletId, userId]
    );

    const res = await clientOrPool.query(
      `SELECT id, user_id, available_balance, deposit_balance, winnings_balance,
              rewards_balance, reserved_balance, locked_balance, version
       FROM wallets WHERE user_id = $1`,
      [userId]
    );
    return res.rows[0];
  }

  /**
   * Read authoritative wallet balance from PostgreSQL.
   */
  public static async getBalance(userId: string): Promise<WalletBalanceState> {
    const pool = WalletService.getPool();
    let res = await pool.query(
      `SELECT deposit_balance, winnings_balance, rewards_balance, available_balance
       FROM wallets WHERE user_id = $1`,
      [userId]
    );

    if (res.rows.length === 0) {
      await WalletService.ensureWallet(pool, userId);
      res = await pool.query(
        `SELECT deposit_balance, winnings_balance, rewards_balance, available_balance
         FROM wallets WHERE user_id = $1`,
        [userId]
      );
    }

    const row = res.rows[0];
    const depositPaise = Number(row.deposit_balance);
    const winningPaise = Number(row.winnings_balance);
    const bonusPaise = Number(row.rewards_balance);
    const totalPaise = depositPaise + winningPaise + bonusPaise;

    return {
      depositPaise,
      winningPaise,
      bonusPaise,
      totalPaise
    };
  }

  /**
   * Atomic Deposit Credit:
   * BEGIN -> Lock row FOR UPDATE -> Verify idempotency -> Credit deposit_balance -> Insert immutable ledger -> COMMIT
   */
  public static async creditDeposit(
    userId: string,
    amountPaise: number,
    referenceId: string,
    description: string = 'Deposit Credit',
    idempotencyKey?: string
  ): Promise<WalletBalanceState> {
    if (amountPaise <= 0) {
      throw new Error('Deposit amount must be positive');
    }

    const idempKey = idempotencyKey || referenceId || `DEP-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const pool = WalletService.getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Check idempotency in ledger
      const existing = await client.query(
        `SELECT id, balance_after FROM wallet_ledger WHERE idempotency_key = $1`,
        [idempKey]
      );
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        Logger.info(`[WALLET] Duplicate deposit ignored for idempotency key ${idempKey}`);
        return await WalletService.getBalance(userId);
      }

      // 2. Ensure wallet exists and lock row
      await WalletService.ensureWallet(client, userId);
      const lockRes = await client.query(
        `SELECT id, deposit_balance, winnings_balance, rewards_balance, available_balance, version
         FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [userId]
      );
      const row = lockRes.rows[0];
      const curDeposit = Number(row.deposit_balance);
      const curWinning = Number(row.winnings_balance);
      const curBonus = Number(row.rewards_balance);
      const balanceBefore = curDeposit + curWinning + curBonus;

      const newDeposit = curDeposit + amountPaise;
      const balanceAfter = newDeposit + curWinning + curBonus;

      // 3. Update wallet balance
      await client.query(
        `UPDATE wallets
         SET deposit_balance = $1,
             available_balance = $2,
             version = version + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $3`,
        [newDeposit, balanceAfter, userId]
      );

      // 4. Create immutable ledger entry
      const ledgerId = `ledg_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
      await client.query(
        `INSERT INTO wallet_ledger (
           id, user_id, wallet_id, type, amount, direction, reference_type,
           reference_id, balance_before, balance_after, status, idempotency_key,
           metadata, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP)`,
        [
          ledgerId,
          userId,
          row.id,
          'DEPOSIT',
          amountPaise,
          'CREDIT',
          'DEPOSIT',
          referenceId,
          balanceBefore,
          balanceAfter,
          'COMPLETED',
          idempKey,
          JSON.stringify({ description })
        ]
      );

      await client.query('COMMIT');
      Logger.info(`[WALLET] Credited ₹${(amountPaise / 100).toFixed(2)} deposit to ${userId} (PG Durable)`);

      return {
        depositPaise: newDeposit,
        winningPaise: curWinning,
        bonusPaise: curBonus,
        totalPaise: balanceAfter
      };
    } catch (err) {
      await client.query('ROLLBACK');
      Logger.error(`[WALLET] creditDeposit transaction error:`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Atomic Winning Payout:
   * Credits winnings_balance only.
   */
  public static async creditWinnings(
    userId: string,
    amountPaise: number,
    referenceId: string,
    description: string = 'Win Payout',
    idempotencyKey?: string,
    extraMetadata?: any
  ): Promise<WalletBalanceState> {
    if (amountPaise <= 0) {
      throw new Error('Winning amount must be positive');
    }

    const idempKey = idempotencyKey || referenceId || `WIN-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const pool = WalletService.getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const existing = await client.query(
        `SELECT id FROM wallet_ledger WHERE idempotency_key = $1`,
        [idempKey]
      );
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        Logger.info(`[WALLET] Duplicate winning payout ignored for idempotency key ${idempKey}`);
        return await WalletService.getBalance(userId);
      }

      await WalletService.ensureWallet(client, userId);
      const lockRes = await client.query(
        `SELECT id, deposit_balance, winnings_balance, rewards_balance, available_balance, version
         FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [userId]
      );
      const row = lockRes.rows[0];
      const curDeposit = Number(row.deposit_balance);
      const curWinning = Number(row.winnings_balance);
      const curBonus = Number(row.rewards_balance);
      const balanceBefore = curDeposit + curWinning + curBonus;

      const newWinning = curWinning + amountPaise;
      const balanceAfter = curDeposit + newWinning + curBonus;

      await client.query(
        `UPDATE wallets
         SET winnings_balance = $1,
             available_balance = $2,
             version = version + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $3`,
        [newWinning, balanceAfter, userId]
      );

      const ledgerId = `ledg_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
      await client.query(
        `INSERT INTO wallet_ledger (
           id, user_id, wallet_id, type, amount, direction, reference_type,
           reference_id, balance_before, balance_after, status, idempotency_key,
           metadata, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP)`,
        [
          ledgerId,
          userId,
          row.id,
          'WIN_PAYOUT',
          amountPaise,
          'CREDIT',
          'GAME_WIN',
          referenceId,
          balanceBefore,
          balanceAfter,
          'COMPLETED',
          idempKey,
          JSON.stringify({ description, ...extraMetadata })
        ]
      );

      await client.query('COMMIT');
      Logger.info(`[WALLET] Credited ₹${(amountPaise / 100).toFixed(2)} winnings to ${userId} (PG Durable)`);

      return {
        depositPaise: curDeposit,
        winningPaise: newWinning,
        bonusPaise: curBonus,
        totalPaise: balanceAfter
      };
    } catch (err) {
      await client.query('ROLLBACK');
      Logger.error(`[WALLET] creditWinnings transaction error:`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Atomic Bonus Reward:
   * Credits rewards_balance only.
   */
  public static async creditBonus(
    userId: string,
    amountPaise: number,
    referenceId: string,
    description: string = 'Bonus Reward',
    idempotencyKey?: string
  ): Promise<WalletBalanceState> {
    if (amountPaise <= 0) {
      throw new Error('Bonus amount must be positive');
    }

    const idempKey = idempotencyKey || referenceId || `BON-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const pool = WalletService.getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const existing = await client.query(
        `SELECT id FROM wallet_ledger WHERE idempotency_key = $1`,
        [idempKey]
      );
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        return await WalletService.getBalance(userId);
      }

      await WalletService.ensureWallet(client, userId);
      const lockRes = await client.query(
        `SELECT id, deposit_balance, winnings_balance, rewards_balance, available_balance, version
         FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [userId]
      );
      const row = lockRes.rows[0];
      const curDeposit = Number(row.deposit_balance);
      const curWinning = Number(row.winnings_balance);
      const curBonus = Number(row.rewards_balance);
      const balanceBefore = curDeposit + curWinning + curBonus;

      const newBonus = curBonus + amountPaise;
      const balanceAfter = curDeposit + curWinning + newBonus;

      await client.query(
        `UPDATE wallets
         SET rewards_balance = $1,
             available_balance = $2,
             version = version + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $3`,
        [newBonus, balanceAfter, userId]
      );

      const ledgerId = `ledg_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
      await client.query(
        `INSERT INTO wallet_ledger (
           id, user_id, wallet_id, type, amount, direction, reference_type,
           reference_id, balance_before, balance_after, status, idempotency_key,
           metadata, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP)`,
        [
          ledgerId,
          userId,
          row.id,
          'BONUS_CREDIT',
          amountPaise,
          'CREDIT',
          'BONUS',
          referenceId,
          balanceBefore,
          balanceAfter,
          'COMPLETED',
          idempKey,
          JSON.stringify({ description })
        ]
      );

      await client.query('COMMIT');

      return {
        depositPaise: curDeposit,
        winningPaise: curWinning,
        bonusPaise: newBonus,
        totalPaise: balanceAfter
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Atomic Bet Debit Rule:
   * BEGIN -> Lock row FOR UPDATE -> Verify balance -> Debit deposit first -> winning second -> bonus third -> Insert ledger -> COMMIT
   */
  public static async debitBet(
    userId: string,
    amountPaise: number,
    referenceId: string,
    description: string = 'Bet Placement',
    idempotencyKey?: string,
    extraMetadata?: any
  ): Promise<DebitResult> {
    if (amountPaise <= 0) {
      return { success: false, message: 'Invalid bet amount' };
    }

    const idempKey = idempotencyKey || referenceId || `BET-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const pool = WalletService.getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Idempotency check: if this bet was already debited, return recorded breakdown
      const existing = await client.query(
        `SELECT id, metadata, balance_after FROM wallet_ledger WHERE idempotency_key = $1`,
        [idempKey]
      );
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        const meta = existing.rows[0].metadata || {};
        const newBalance = await WalletService.getBalance(userId);
        return {
          success: true,
          debitBreakdown: {
            depositDebited: meta.depositDebited || 0,
            winningDebited: meta.winningDebited || 0,
            bonusDebited: meta.bonusDebited || 0
          },
          newBalance
        };
      }

      await WalletService.ensureWallet(client, userId);
      const lockRes = await client.query(
        `SELECT id, deposit_balance, winnings_balance, rewards_balance, available_balance, version
         FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [userId]
      );
      const row = lockRes.rows[0];
      let dep = Number(row.deposit_balance);
      let win = Number(row.winnings_balance);
      let bon = Number(row.rewards_balance);
      const totalAvailable = dep + win + bon;

      if (totalAvailable < amountPaise) {
        await client.query('ROLLBACK');
        return { success: false, message: 'Insufficient balance' };
      }

      // Debit order: deposit -> winning -> bonus
      let remaining = amountPaise;
      const depositDebited = Math.min(dep, remaining);
      remaining -= depositDebited;
      dep -= depositDebited;

      const winningDebited = Math.min(win, remaining);
      remaining -= winningDebited;
      win -= winningDebited;

      const bonusDebited = Math.min(bon, remaining);
      remaining -= bonusDebited;
      bon -= bonusDebited;

      if (remaining > 0) {
        await client.query('ROLLBACK');
        return { success: false, message: 'Insufficient bucket funds' };
      }

      const balanceAfter = dep + win + bon;

      await client.query(
        `UPDATE wallets
         SET deposit_balance = $1,
             winnings_balance = $2,
             rewards_balance = $3,
             available_balance = $4,
             version = version + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $5`,
        [dep, win, bon, balanceAfter, userId]
      );

      const ledgerId = `ledg_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
      await client.query(
        `INSERT INTO wallet_ledger (
           id, user_id, wallet_id, type, amount, direction, reference_type,
           reference_id, balance_before, balance_after, status, idempotency_key,
           metadata, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP)`,
        [
          ledgerId,
          userId,
          row.id,
          'BET_DEBIT',
          amountPaise,
          'DEBIT',
          'GAME_BET',
          referenceId,
          totalAvailable,
          balanceAfter,
          'COMPLETED',
          idempKey,
          JSON.stringify({
            depositDebited,
            winningDebited,
            bonusDebited,
            description,
            ...extraMetadata
          })
        ]
      );

      await client.query('COMMIT');

      return {
        success: true,
        debitBreakdown: { depositDebited, winningDebited, bonusDebited },
        newBalance: {
          depositPaise: dep,
          winningPaise: win,
          bonusPaise: bon,
          totalPaise: balanceAfter
        }
      };
    } catch (err) {
      await client.query('ROLLBACK');
      Logger.error(`[WALLET] debitBet transaction error:`, err);
      return { success: false, message: 'Database error processing bet' };
    } finally {
      client.release();
    }
  }

  /**
   * Refund Equity Rule:
   * Restores debited funds back to their original bucket source.
   */
  public static async refundEquity(
    userId: string,
    depositPaise: number,
    winningPaise: number,
    bonusPaise: number,
    referenceId: string,
    description: string = 'Bet Refund',
    idempotencyKey?: string
  ): Promise<WalletBalanceState> {
    const totalRefund = depositPaise + winningPaise + bonusPaise;
    if (totalRefund <= 0) {
      return await WalletService.getBalance(userId);
    }

    const idempKey = idempotencyKey || `REF-${referenceId}` || `REF-${Date.now()}`;
    const pool = WalletService.getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const existing = await client.query(
        `SELECT id FROM wallet_ledger WHERE idempotency_key = $1`,
        [idempKey]
      );
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        return await WalletService.getBalance(userId);
      }

      await WalletService.ensureWallet(client, userId);
      const lockRes = await client.query(
        `SELECT id, deposit_balance, winnings_balance, rewards_balance, available_balance, version
         FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [userId]
      );
      const row = lockRes.rows[0];
      const curDeposit = Number(row.deposit_balance);
      const curWinning = Number(row.winnings_balance);
      const curBonus = Number(row.rewards_balance);
      const balanceBefore = curDeposit + curWinning + curBonus;

      const newDeposit = curDeposit + depositPaise;
      const newWinning = curWinning + winningPaise;
      const newBonus = curBonus + bonusPaise;
      const balanceAfter = newDeposit + newWinning + newBonus;

      await client.query(
        `UPDATE wallets
         SET deposit_balance = $1,
             winnings_balance = $2,
             rewards_balance = $3,
             available_balance = $4,
             version = version + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $5`,
        [newDeposit, newWinning, newBonus, balanceAfter, userId]
      );

      const ledgerId = `ledg_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
      await client.query(
        `INSERT INTO wallet_ledger (
           id, user_id, wallet_id, type, amount, direction, reference_type,
           reference_id, balance_before, balance_after, status, idempotency_key,
           metadata, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP)`,
        [
          ledgerId,
          userId,
          row.id,
          'BET_REFUND',
          totalRefund,
          'CREDIT',
          'REFUND',
          referenceId,
          balanceBefore,
          balanceAfter,
          'COMPLETED',
          idempKey,
          JSON.stringify({
            depositRefunded: depositPaise,
            winningRefunded: winningPaise,
            bonusRefunded: bonusPaise,
            description
          })
        ]
      );

      await client.query('COMMIT');

      return {
        depositPaise: newDeposit,
        winningPaise: newWinning,
        bonusPaise: newBonus,
        totalPaise: balanceAfter
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Atomic Withdrawal Request Debit:
   * Only debits from winnings_balance.
   */
  public static async debitWithdrawal(
    userId: string,
    amountPaise: number,
    withdrawalId: string,
    upiId: string,
    idempotencyKey?: string
  ): Promise<{ success: boolean; message: string; newBalance?: WalletBalanceState }> {
    const minPaise = 2500;   // ₹25
    const maxPaise = 500000; // ₹5,000

    if (amountPaise < minPaise) return { success: false, message: 'Minimum withdrawal amount is ₹25' };
    if (amountPaise > maxPaise) return { success: false, message: 'Maximum withdrawal amount is ₹5,000 per request' };

    const idempKey = idempotencyKey || `WD-${withdrawalId}`;
    const pool = WalletService.getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const existing = await client.query(
        `SELECT id FROM wallet_ledger WHERE idempotency_key = $1`,
        [idempKey]
      );
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        return {
          success: true,
          message: 'Withdrawal already processed',
          newBalance: await WalletService.getBalance(userId)
        };
      }

      await WalletService.ensureWallet(client, userId);
      const lockRes = await client.query(
        `SELECT id, deposit_balance, winnings_balance, rewards_balance, available_balance, version
         FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [userId]
      );
      const row = lockRes.rows[0];
      const curWinning = Number(row.winnings_balance);
      const curDeposit = Number(row.deposit_balance);
      const curBonus = Number(row.rewards_balance);

      if (amountPaise > curWinning) {
        await client.query('ROLLBACK');
        return {
          success: false,
          message: `Insufficient Winnings Balance (Available: ₹${(curWinning / 100).toFixed(2)})`
        };
      }

      const newWinning = curWinning - amountPaise;
      const balanceBefore = curDeposit + curWinning + curBonus;
      const balanceAfter = curDeposit + newWinning + curBonus;

      await client.query(
        `UPDATE wallets
         SET winnings_balance = $1,
             available_balance = $2,
             version = version + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $3`,
        [newWinning, balanceAfter, userId]
      );

      const ledgerId = `ledg_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
      await client.query(
        `INSERT INTO wallet_ledger (
           id, user_id, wallet_id, type, amount, direction, reference_type,
           reference_id, balance_before, balance_after, status, idempotency_key,
           metadata, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP)`,
        [
          ledgerId,
          userId,
          row.id,
          'WITHDRAWAL',
          amountPaise,
          'DEBIT',
          'WITHDRAWAL',
          withdrawalId,
          balanceBefore,
          balanceAfter,
          'COMPLETED',
          idempKey,
          JSON.stringify({ upiId, description: `Withdrawal to UPI: ${upiId}` })
        ]
      );

      await client.query('COMMIT');

      const newBal: WalletBalanceState = {
        depositPaise: curDeposit,
        winningPaise: newWinning,
        bonusPaise: curBonus,
        totalPaise: balanceAfter
      };

      return {
        success: true,
        message: `Withdrawal request of ₹${(amountPaise / 100).toFixed(2)} submitted successfully!`,
        newBalance: newBal
      };
    } catch (err) {
      await client.query('ROLLBACK');
      Logger.error(`[WALLET] debitWithdrawal transaction error:`, err);
      return { success: false, message: 'Database error processing withdrawal' };
    } finally {
      client.release();
    }
  }

  /**
   * Refund Rejected Withdrawal:
   * Restores funds to winnings_balance.
   */
  public static async refundWithdrawal(
    userId: string,
    amountPaise: number,
    withdrawalId: string,
    idempotencyKey?: string
  ): Promise<WalletBalanceState> {
    const idempKey = idempotencyKey || `REF-${withdrawalId}`;
    const pool = WalletService.getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const existing = await client.query(
        `SELECT id FROM wallet_ledger WHERE idempotency_key = $1`,
        [idempKey]
      );
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        return await WalletService.getBalance(userId);
      }

      await WalletService.ensureWallet(client, userId);
      const lockRes = await client.query(
        `SELECT id, deposit_balance, winnings_balance, rewards_balance, available_balance, version
         FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [userId]
      );
      const row = lockRes.rows[0];
      const curWinning = Number(row.winnings_balance);
      const curDeposit = Number(row.deposit_balance);
      const curBonus = Number(row.rewards_balance);
      const balanceBefore = curDeposit + curWinning + curBonus;

      const newWinning = curWinning + amountPaise;
      const balanceAfter = curDeposit + newWinning + curBonus;

      await client.query(
        `UPDATE wallets
         SET winnings_balance = $1,
             available_balance = $2,
             version = version + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $3`,
        [newWinning, balanceAfter, userId]
      );

      const ledgerId = `ledg_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
      await client.query(
        `INSERT INTO wallet_ledger (
           id, user_id, wallet_id, type, amount, direction, reference_type,
           reference_id, balance_before, balance_after, status, idempotency_key,
           metadata, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP)`,
        [
          ledgerId,
          userId,
          row.id,
          'BET_REFUND',
          amountPaise,
          'CREDIT',
          'WITHDRAWAL',
          `REF-${withdrawalId}`,
          balanceBefore,
          balanceAfter,
          'COMPLETED',
          idempKey,
          JSON.stringify({ description: 'Withdrawal Rejected & Refunded' })
        ]
      );

      await client.query('COMMIT');

      return {
        depositPaise: curDeposit,
        winningPaise: newWinning,
        bonusPaise: curBonus,
        totalPaise: balanceAfter
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Authoritative transaction ledger from PostgreSQL.
   */
  public static async getTransactions(userId: string, limit: number = 50): Promise<Transaction[]> {
    const pool = WalletService.getPool();
    const res = await pool.query(
      `SELECT id, user_id, type, amount, balance_after, status, reference_id, metadata, created_at
       FROM wallet_ledger
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );

    return res.rows.map((r: any) => {
      const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
      return {
        id: r.id,
        userId: r.user_id,
        type: r.type,
        amountPaise: Number(r.amount),
        balanceAfterPaise: Number(r.balance_after),
        status: (r.status === 'COMPLETED' ? 'SUCCESS' : r.status) as any,
        referenceId: r.reference_id || r.id,
        description: meta.description || `${r.type} transaction`,
        timestamp: new Date(r.created_at).getTime()
      };
    });
  }
}
