import crypto from 'crypto';
import {
  DepositOrder,
  DepositStatus,
  WithdrawalRecord,
  WithdrawalStatus
} from '../models/DepositOrder';
import { WalletService } from '../modules/wallet/wallet.service';
import { TelegramBotService } from './TelegramBotService';
import { AuthService } from '../modules/auth/auth.service';
import { SocketServer } from '../sockets/socket.server';
import { DatabaseConfig } from '../config/db.config';

export class FinancialService {
  private static inFlightOps = new Set<string>();
  private static depositOrders = new Map<string, DepositOrder>();
  private static withdrawalRecords = new Map<string, WithdrawalRecord>();

  /**
   * Initializes financial records directly from PostgreSQL (single source of truth).
   */
  public static async initFromPostgres(): Promise<void> {
    try {
      const pool = DatabaseConfig.getPool();
      if (!pool) return;

      const [depositsRes, withdrawalsRes] = await Promise.all([
        pool.query(`SELECT * FROM deposits ORDER BY created_at DESC LIMIT 1000`),
        pool.query(`SELECT * FROM withdrawals ORDER BY created_at DESC LIMIT 1000`)
      ]);

      for (const row of depositsRes.rows) {
        const depositId = row.deposit_id || row.id;
        const amountPaise = Number(row.amount);
        const order: DepositOrder = {
          depositId,
          userId: row.user_id,
          amountRupees: amountPaise / 100,
          amountPaise,
          status: row.status as DepositStatus,
          utr: row.utr || undefined,
          createdAt: new Date(row.created_at).getTime(),
          updatedAt: new Date(row.updated_at || row.created_at).getTime()
        };
        FinancialService.depositOrders.set(depositId, order);
      }

      for (const row of withdrawalsRes.rows) {
        const withdrawalId = row.withdrawal_id || row.id;
        const amountPaise = Number(row.amount);
        const record: WithdrawalRecord = {
          withdrawalId,
          userId: row.user_id,
          amountRupees: amountPaise / 100,
          amountPaise,
          payoutMethod: row.payout_method || 'UPI',
          upiId: row.upi_id || row.payout_address_or_upi || '',
          status: row.status as WithdrawalStatus,
          createdAt: new Date(row.created_at).getTime(),
          updatedAt: new Date(row.updated_at || row.created_at).getTime()
        };
        FinancialService.withdrawalRecords.set(withdrawalId, record);
      }
    } catch (e: any) {
      console.warn('[FINANCIAL] PostgreSQL load note:', e.message);
    }
  }

  private static persist() {
    // Deprecated: dual-write to financial_ledger.json removed.
    // PostgreSQL is now the authoritative single source of truth.
  }

  public static initiateDeposit(userId: string, amountRupees: number): DepositOrder {
    AuthService.ensureUserExists(userId);
    const amountPaise = Math.round(amountRupees * 100);
    const depositId = `DEP-${crypto.randomUUID()}`;

    const order: DepositOrder = {
      depositId,
      userId,
      amountRupees,
      amountPaise,
      status: DepositStatus.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    FinancialService.depositOrders.set(depositId, order);
    FinancialService.persist();

    // Sync to PostgreSQL deposits table
    (async () => {
      try {
        const pool = DatabaseConfig.getPool();
        if (pool) {
          await pool.query(
            `INSERT INTO deposits (id, deposit_id, user_id, amount, currency, status, payment_method, created_at, updated_at)
             VALUES ($1, $1, $2, $3, 'INR', $4, 'UPI', to_timestamp($5 / 1000.0), CURRENT_TIMESTAMP)
             ON CONFLICT (id) DO NOTHING`,
            [order.depositId, order.userId, order.amountPaise, order.status, order.createdAt]
          );
        }
      } catch (err: any) {
        console.error('[FINANCIAL] Failed to sync initiated deposit to PostgreSQL:', err.message);
      }
    })();

    TelegramBotService.sendAlert(
      `💳 *Deposit Initiated*\nOrder: \`${depositId}\`\nUser: \`${userId}\`\nAmount: ₹${amountRupees.toFixed(2)}`
    );

    return order;
  }

  public static submitUtr(
    depositId: string,
    utr: string,
    fallbackUserId?: string,
    fallbackAmountRupees?: number
  ): { success: boolean; message: string; order?: DepositOrder } {
    let order = FinancialService.depositOrders.get(depositId);
    if (!order) {
      if (fallbackUserId && fallbackAmountRupees) {
        order = {
          depositId,
          userId: fallbackUserId,
          amountRupees: fallbackAmountRupees,
          amountPaise: Math.round(fallbackAmountRupees * 100),
          status: DepositStatus.PENDING,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        FinancialService.depositOrders.set(depositId, order);
      } else {
        return { success: false, message: 'Deposit request not found' };
      }
    }

    AuthService.ensureUserExists(order.userId);

    if (!utr || utr.trim().length < 6) {
      return { success: false, message: 'Please enter a valid UTR / Reference Number' };
    }

    order.utr = utr.trim();
    order.updatedAt = Date.now();
    FinancialService.depositOrders.set(depositId, order);
    FinancialService.persist();

    // Sync to PostgreSQL deposits table
    (async () => {
      try {
        const { DatabaseConfig } = await import('../config/db.config');
        const pool = DatabaseConfig.getPool();
        if (pool) {
          await pool.query(
            `INSERT INTO deposits (id, deposit_id, user_id, amount, currency, status, payment_method, utr, created_at, updated_at)
             VALUES ($1, $1, $2, $3, 'INR', $4, 'UPI', $5, to_timestamp($6 / 1000.0), CURRENT_TIMESTAMP)
             ON CONFLICT (id) DO UPDATE
             SET status = EXCLUDED.status,
                 utr = COALESCE(EXCLUDED.utr, deposits.utr),
                 updated_at = CURRENT_TIMESTAMP`,
            [order.depositId, order.userId, order.amountPaise, order.status, order.utr || null, order.createdAt]
          );
        }
      } catch (err: any) {
        console.error('[FINANCIAL] Failed to sync deposit to PostgreSQL:', err.message);
      }
    })();

    // Send Telegram alert to Admin
    try {
      TelegramBotService.sendAlert(
        `📥 *New Deposit Pending Approval*\nOrder: \`${depositId}\`\nUser: \`${order.userId}\`\nAmount: ₹${order.amountRupees.toFixed(2)}\nUTR: \`${order.utr}\``
      ).catch((err) => console.error('Telegram Bot Alert send failed:', err));
    } catch (e) {
      console.error('Telegram Bot Alert error:', e);
    }

    return { success: true, message: 'UTR submitted successfully. Awaiting Admin Approval.', order };
  }

  public static getDeposit(depositId: string): DepositOrder | undefined {
    return FinancialService.depositOrders.get(depositId);
  }

  public static getPendingDeposits(): DepositOrder[] {
    return Array.from(FinancialService.depositOrders.values())
      .filter((d) => d.status === DepositStatus.PENDING)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  public static getAllDeposits(): DepositOrder[] {
    return Array.from(FinancialService.depositOrders.values())
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  public static async approveDeposit(depositId: string, idempotencyKey?: string): Promise<{ success: boolean; message: string; order?: DepositOrder }> {
    const opLock = `DEP_${depositId}`;
    if (FinancialService.inFlightOps.has(opLock)) {
      return { success: false, message: 'Deposit approval/rejection operation is currently in-flight' };
    }
    FinancialService.inFlightOps.add(opLock);

    try {
      const order = FinancialService.depositOrders.get(depositId);
      if (!order) return { success: false, message: 'Deposit order not found' };

      // Idempotency: If already approved, return success idempotently
      if (order.status === DepositStatus.APPROVED) {
        return { success: true, message: 'Deposit is already approved', order };
      }

      // Invalid transition: Cannot approve rejected deposit
      if (order.status === DepositStatus.REJECTED) {
        return { success: false, message: 'Cannot approve deposit in status REJECTED', order };
      }

      // Atomic DB conditional update (CAS)
      const pool = DatabaseConfig.getPool();
      if (pool) {
        try {
          await pool.query(`
            CREATE TABLE IF NOT EXISTS deposits (
              id VARCHAR(64) PRIMARY KEY,
              user_id VARCHAR(64) NOT NULL,
              amount BIGINT NOT NULL,
              status VARCHAR(32) NOT NULL,
              utr VARCHAR(128),
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
          `);
          const updateRes = await pool.query(
            `UPDATE deposits SET status = 'APPROVED', confirmed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE (id = $1 OR deposit_id = $1) AND status = 'PENDING' RETURNING *;`,
            [order.depositId]
          );
          if (updateRes.rowCount === 0) {
            const checkRes = await pool.query(`SELECT status FROM deposits WHERE (id = $1 OR deposit_id = $1)`, [order.depositId]);
            if (checkRes.rows.length === 0) {
              await pool.query(
                `INSERT INTO deposits (id, deposit_id, user_id, amount, currency, status, payment_method, utr, confirmed_at, created_at, updated_at)
                 VALUES ($1, $1, $2, $3, 'INR', 'APPROVED', 'UPI', $4, CURRENT_TIMESTAMP, to_timestamp($5 / 1000.0), CURRENT_TIMESTAMP)
                 ON CONFLICT (id) DO UPDATE SET status = 'APPROVED', confirmed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`,
                [order.depositId, order.userId, order.amountPaise, order.utr || null, order.createdAt]
              );
            } else if (checkRes.rows[0].status === 'APPROVED') {
              order.status = DepositStatus.APPROVED;
              return { success: true, message: 'Deposit already approved', order };
            } else if (checkRes.rows[0].status === 'REJECTED') {
              order.status = DepositStatus.REJECTED;
              return { success: false, message: 'Cannot approve deposit in status REJECTED', order };
            }
          }
        } catch (err: any) {
          console.warn('[FINANCIAL] Failed to update deposit status in PostgreSQL:', err.message);
        }
      }

      const idempKey = idempotencyKey || `DEP_APPR_${order.depositId}`;
      let updatedBalance;
      try {
        // Credit user deposit balance atomically in PostgreSQL
        updatedBalance = await WalletService.creditDeposit(
          order.userId,
          order.amountPaise,
          order.utr || order.depositId,
          'Deposit Approved',
          idempKey
        );
      } catch (err: any) {
        console.error('[FINANCIAL] Wallet credit failed during deposit approval:', err.message);
        return { success: false, message: `Failed to credit wallet: ${err.message}` };
      }

      order.status = DepositStatus.APPROVED;
      order.updatedAt = Date.now();
      FinancialService.depositOrders.set(depositId, order);
      FinancialService.persist();

      // Live sync over WebSockets to client app & webpage
      try {
        SocketServer.emitToUser(order.userId, 'WALLET_UPDATE', {
          userId: order.userId,
          depositPaise: updatedBalance.depositPaise,
          winningPaise: updatedBalance.winningPaise,
          bonusPaise: updatedBalance.bonusPaise,
          totalPaise: updatedBalance.totalPaise,
          depositRupees: updatedBalance.depositPaise / 100,
          winningRupees: updatedBalance.winningPaise / 100,
          bonusRupees: updatedBalance.bonusPaise / 100,
          totalRupees: updatedBalance.totalPaise / 100
        });
        SocketServer.emitToUser(order.userId, 'DEPOSIT_STATUS', {
          depositId: order.depositId,
          status: DepositStatus.APPROVED,
          amountRupees: order.amountRupees
        });
        SocketServer.emitToUser(order.userId, 'WALLET_UPDATE', {
          userId: order.userId,
          wallet: updatedBalance
        });
      } catch (err) {
        console.error('Socket notification error on deposit approval:', err);
      }

      TelegramBotService.sendAlert(
        `✅ *Deposit Approved*\nOrder: \`${depositId}\`\nUser: \`${order.userId}\`\nAmount: ₹${order.amountRupees.toFixed(2)}`
      );

      return { success: true, message: `Deposit ₹${order.amountRupees} approved and credited!`, order };
    } finally {
      FinancialService.inFlightOps.delete(opLock);
    }
  }

  public static async rejectDeposit(depositId: string, _idempotencyKey?: string): Promise<{ success: boolean; message: string; order?: DepositOrder }> {
    const opLock = `DEP_${depositId}`;
    if (FinancialService.inFlightOps.has(opLock)) {
      return { success: false, message: 'Deposit approval/rejection operation is currently in-flight' };
    }
    FinancialService.inFlightOps.add(opLock);

    try {
      const order = FinancialService.depositOrders.get(depositId);
      if (!order) return { success: false, message: 'Deposit order not found' };

      // Idempotency: If already rejected, return success idempotently
      if (order.status === DepositStatus.REJECTED) {
        return { success: true, message: 'Deposit is already rejected', order };
      }

      // Invalid transition: Cannot reject already approved deposit
      if (order.status === DepositStatus.APPROVED) {
        return { success: false, message: 'Cannot reject already approved deposit', order };
      }

      // Update PostgreSQL deposits table with state condition
      const pool = DatabaseConfig.getPool();
      if (pool) {
        try {
          await pool.query(
            `UPDATE deposits SET status = 'REJECTED', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'PENDING'`,
            [order.depositId]
          );
        } catch (err: any) {
          console.error('[FINANCIAL] Failed to update deposit status in PostgreSQL:', err.message);
        }
      }

      order.status = DepositStatus.REJECTED;
      order.updatedAt = Date.now();
      FinancialService.depositOrders.set(depositId, order);
      FinancialService.persist();

      TelegramBotService.sendAlert(
        `❌ *Deposit Rejected*\nOrder: \`${depositId}\`\nUser: \`${order.userId}\`\nAmount: ₹${order.amountRupees.toFixed(2)}`
      );

      return { success: true, message: `Deposit request rejected.`, order };
    } finally {
      FinancialService.inFlightOps.delete(opLock);
    }
  }

  // Withdrawals Queue
  public static async requestWithdrawal(
    userId: string,
    amountRupees: number,
    upiId: string
  ): Promise<{ success: boolean; message: string; record?: WithdrawalRecord }> {
    const amountPaise = Math.round(amountRupees * 100);
    const minPaise = 2500;   // ₹25
    const maxPaise = 500000; // ₹5,000

    if (amountPaise < minPaise) return { success: false, message: 'Minimum withdrawal amount is ₹25' };
    if (amountPaise > maxPaise) return { success: false, message: 'Maximum withdrawal amount is ₹5,000 per request' };

    const withdrawalId = `WDR-${crypto.randomUUID()}`;

    // Debit winnings atomically in PostgreSQL
    const debitRes = await WalletService.debitWithdrawal(userId, amountPaise, withdrawalId, upiId);
    if (!debitRes.success) {
      return { success: false, message: debitRes.message };
    }

    const record: WithdrawalRecord = {
      withdrawalId,
      userId,
      amountRupees,
      amountPaise,
      payoutMethod: 'UPI',
      upiId,
      status: WithdrawalStatus.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    FinancialService.withdrawalRecords.set(withdrawalId, record);
    FinancialService.persist();

    // Sync to PostgreSQL withdrawals table
    (async () => {
      try {
        const pool = DatabaseConfig.getPool();
        if (pool) {
          await pool.query(`
            CREATE TABLE IF NOT EXISTS withdrawals (
              id VARCHAR(64) PRIMARY KEY,
              user_id VARCHAR(64) NOT NULL,
              amount BIGINT NOT NULL,
              status VARCHAR(32) NOT NULL,
              upi_id VARCHAR(128),
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
          `);
          await pool.query(
            `INSERT INTO withdrawals (id, withdrawal_id, user_id, amount, currency, status, payout_method, payout_address_or_upi, upi_id, created_at, updated_at)
             VALUES ($1, $1, $2, $3, 'INR', $4, 'UPI', $5, $5, to_timestamp($6 / 1000.0), CURRENT_TIMESTAMP)
             ON CONFLICT (id) DO NOTHING`,
            [record.withdrawalId, record.userId, record.amountPaise, record.status, record.upiId, record.createdAt]
          );
        }
      } catch (err: any) {
        console.error('[FINANCIAL] Failed to sync withdrawal to PostgreSQL:', err.message);
      }
    })();

    TelegramBotService.sendAlert(
      `💸 *New Withdrawal Request Pending*\nID: \`${withdrawalId}\`\nUser: \`${userId}\`\nAmount: ₹${amountRupees.toFixed(2)}\nUPI: \`${upiId}\``
    );

    return { success: true, message: `Withdrawal request of ₹${amountRupees.toFixed(2)} submitted for Admin Approval!`, record };
  }

  public static getPendingWithdrawals(): WithdrawalRecord[] {
    return Array.from(FinancialService.withdrawalRecords.values())
      .filter((w) => w.status === WithdrawalStatus.PENDING)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  public static getAllWithdrawals(): WithdrawalRecord[] {
    return Array.from(FinancialService.withdrawalRecords.values())
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  public static processWithdrawal(withdrawalId: string): { success: boolean; message: string; record?: WithdrawalRecord } {
    const record = FinancialService.withdrawalRecords.get(withdrawalId);
    if (!record) return { success: false, message: 'Withdrawal record not found' };

    if (record.status !== WithdrawalStatus.PENDING) {
      return { success: false, message: `Withdrawal cannot be moved to processing from ${record.status}` };
    }

    record.status = WithdrawalStatus.PROCESSING;
    record.updatedAt = Date.now();
    FinancialService.withdrawalRecords.set(withdrawalId, record);
    FinancialService.persist();

    try {
      SocketServer.emitToUser(record.userId, 'WITHDRAWAL_STATUS', {
        withdrawalId: record.withdrawalId,
        status: WithdrawalStatus.PROCESSING,
        amountRupees: record.amountRupees
      });
    } catch (e) {
      console.error('Socket error on withdrawal processing:', e);
    }

    TelegramBotService.sendAlert(
      `⏳ *Withdrawal In Processing*\nID: \`${withdrawalId}\`\nUser: \`${record.userId}\`\nAmount: ₹${record.amountRupees.toFixed(2)}\nUPI: \`${record.upiId}\``
    );

    return { success: true, message: `Withdrawal ${withdrawalId} moved to PROCESSING!`, record };
  }

  public static async approveWithdrawal(withdrawalId: string, _idempotencyKey?: string): Promise<{ success: boolean; message: string; record?: WithdrawalRecord }> {
    const opLock = `WD_${withdrawalId}`;
    if (FinancialService.inFlightOps.has(opLock)) {
      return { success: false, message: 'Withdrawal operation is currently in-flight' };
    }
    FinancialService.inFlightOps.add(opLock);

    try {
      const record = FinancialService.withdrawalRecords.get(withdrawalId);
      if (!record) return { success: false, message: 'Withdrawal record not found' };

      // Idempotency: If already approved, return success
      if (record.status === WithdrawalStatus.APPROVED) {
        return { success: true, message: 'Withdrawal is already approved', record };
      }

      // Invalid transition: Cannot approve already rejected withdrawal
      if (record.status === WithdrawalStatus.REJECTED) {
        return { success: false, message: 'Cannot approve already rejected withdrawal', record };
      }

      // Atomic DB conditional update
      const pool = DatabaseConfig.getPool();
      if (pool) {
        try {
          await pool.query(`
            CREATE TABLE IF NOT EXISTS withdrawals (
              id VARCHAR(64) PRIMARY KEY,
              user_id VARCHAR(64) NOT NULL,
              amount BIGINT NOT NULL,
              status VARCHAR(32) NOT NULL,
              upi_id VARCHAR(128),
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
          `);
          await pool.query(
            `UPDATE withdrawals SET status = 'APPROVED', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE (id = $1 OR withdrawal_id = $1) AND status IN ('PENDING', 'PROCESSING')`,
            [record.withdrawalId]
          );
        } catch (e: any) {
          console.warn('[FINANCIAL] DB withdrawal approve warning:', e.message);
        }
      }

      record.status = WithdrawalStatus.APPROVED;
      record.updatedAt = Date.now();
      FinancialService.withdrawalRecords.set(withdrawalId, record);
      FinancialService.persist();

      try {
        SocketServer.emitToUser(record.userId, 'WITHDRAWAL_STATUS', {
          withdrawalId: record.withdrawalId,
          status: WithdrawalStatus.APPROVED,
          amountRupees: record.amountRupees
        });
      } catch (e) {
        console.error('Socket error on withdrawal approval:', e);
      }

      TelegramBotService.sendAlert(
        `✅ *Withdrawal Approved & Paid*\nID: \`${withdrawalId}\`\nUser: \`${record.userId}\`\nAmount: ₹${record.amountRupees.toFixed(2)}\nUPI: \`${record.upiId}\``
      );

      return { success: true, message: `Withdrawal of ₹${record.amountRupees} approved and paid out!`, record };
    } finally {
      FinancialService.inFlightOps.delete(opLock);
    }
  }

  public static async rejectWithdrawal(withdrawalId: string, idempotencyKey?: string): Promise<{ success: boolean; message: string; record?: WithdrawalRecord }> {
    const opLock = `WD_${withdrawalId}`;
    if (FinancialService.inFlightOps.has(opLock)) {
      return { success: false, message: 'Withdrawal operation is currently in-flight' };
    }
    FinancialService.inFlightOps.add(opLock);

    try {
      const record = FinancialService.withdrawalRecords.get(withdrawalId);
      if (!record) return { success: false, message: 'Withdrawal request not found' };

      // Idempotency: If already rejected, return success
      if (record.status === WithdrawalStatus.REJECTED) {
        return { success: true, message: 'Withdrawal is already rejected', record };
      }

      // Invalid transition: Cannot reject already approved withdrawal
      if (record.status === WithdrawalStatus.APPROVED) {
        return { success: false, message: 'Cannot reject already approved and paid-out withdrawal', record };
      }

      // Atomic DB conditional update
      const pool = DatabaseConfig.getPool();
      if (pool) {
        try {
          await pool.query(`
            CREATE TABLE IF NOT EXISTS withdrawals (
              id VARCHAR(64) PRIMARY KEY,
              user_id VARCHAR(64) NOT NULL,
              amount BIGINT NOT NULL,
              status VARCHAR(32) NOT NULL,
              upi_id VARCHAR(128),
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
          `);
          await pool.query(
            `UPDATE withdrawals SET status = 'REJECTED', rejected_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE (id = $1 OR withdrawal_id = $1) AND status IN ('PENDING', 'PROCESSING')`,
            [record.withdrawalId]
          );
        } catch (e: any) {
          console.warn('[FINANCIAL] DB withdrawal reject warning:', e.message);
        }
      }

      record.status = WithdrawalStatus.REJECTED;
      record.updatedAt = Date.now();
      FinancialService.withdrawalRecords.set(withdrawalId, record);
      FinancialService.persist();

      // Refund debited winnings back to user atomically in PostgreSQL with idempotency
      const idempKey = idempotencyKey || `REF-${withdrawalId}`;
      const updatedWallet = await WalletService.refundWithdrawal(record.userId, record.amountPaise, withdrawalId, idempKey);

      try {
        SocketServer.emitToUser(record.userId, 'WITHDRAWAL_STATUS', {
          withdrawalId: record.withdrawalId,
          status: WithdrawalStatus.REJECTED,
          amountRupees: record.amountRupees
        });
        if (updatedWallet) {
          SocketServer.emitToUser(record.userId, 'WALLET_UPDATE', {
            userId: record.userId,
            depositPaise: updatedWallet.depositPaise,
            winningPaise: updatedWallet.winningPaise,
            bonusPaise: updatedWallet.bonusPaise,
            totalPaise: updatedWallet.totalPaise,
            depositRupees: updatedWallet.depositPaise / 100,
            winningRupees: updatedWallet.winningPaise / 100,
            bonusRupees: updatedWallet.bonusPaise / 100,
            totalRupees: updatedWallet.totalPaise / 100
          });
        }
      } catch (e) {
        console.error('Socket error on withdrawal rejection:', e);
      }

      TelegramBotService.sendAlert(
        `❌ *Withdrawal Rejected & Refunded*\nID: \`${withdrawalId}\`\nUser: \`${record.userId}\`\nAmount: ₹${record.amountRupees.toFixed(2)}`
      );

      return { success: true, message: `Withdrawal rejected and ₹${record.amountRupees} refunded to winnings balance.`, record };
    } finally {
      FinancialService.inFlightOps.delete(opLock);
    }
  }
}
