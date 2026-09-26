import fs from 'fs';
import path from 'path';
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

const LEDGER_FILE = path.join(__dirname, '../../data/financial_ledger.json');

function loadLedger(): { deposits: DepositOrder[]; withdrawals: WithdrawalRecord[] } {
  try {
    if (fs.existsSync(LEDGER_FILE)) {
      const data = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf-8'));
      return {
        deposits: Array.isArray(data.deposits) ? data.deposits : [],
        withdrawals: Array.isArray(data.withdrawals) ? data.withdrawals : []
      };
    }
  } catch (e) {
    console.error('Failed to load financial ledger from disk:', e);
  }
  return {
    deposits: [],
    withdrawals: []
  };
}

const initialLedger = loadLedger();

export class FinancialService {
  private static depositOrders = new Map<string, DepositOrder>(
    initialLedger.deposits.map(d => [d.depositId, d])
  );
  private static withdrawalRecords = new Map<string, WithdrawalRecord>(
    initialLedger.withdrawals.map(w => [w.withdrawalId, w])
  );

  private static persist() {
    try {
      const dir = path.dirname(LEDGER_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(LEDGER_FILE, JSON.stringify({
        deposits: Array.from(FinancialService.depositOrders.values()),
        withdrawals: Array.from(FinancialService.withdrawalRecords.values())
      }, null, 2), 'utf-8');
    } catch (e) {
      console.error('Failed to persist financial ledger:', e);
    }
  }

  public static initiateDeposit(userId: string, amountRupees: number): DepositOrder {
    AuthService.ensureUserExists(userId);
    const amountPaise = Math.round(amountRupees * 100);
    const rand12 = Math.floor(100000000000 + Math.random() * 900000000000);
    const depositId = `D${rand12}`;

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
            `INSERT INTO deposits (id, user_id, amount, status, utr, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), CURRENT_TIMESTAMP)
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

  public static async approveDeposit(depositId: string): Promise<{ success: boolean; message: string; order?: DepositOrder }> {
    const order = FinancialService.depositOrders.get(depositId);
    if (!order) return { success: false, message: 'Deposit order not found' };

    if (order.status !== DepositStatus.PENDING) {
      return { success: false, message: `Deposit is already ${order.status}` };
    }

    order.status = DepositStatus.APPROVED;
    order.updatedAt = Date.now();
    FinancialService.depositOrders.set(depositId, order);
    FinancialService.persist();

    // Update PostgreSQL deposits table
    (async () => {
      try {
        const { DatabaseConfig } = await import('../config/db.config');
        const pool = DatabaseConfig.getPool();
        if (pool) {
          await pool.query(
            `UPDATE deposits SET status = 'APPROVED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [order.depositId]
          );
        }
      } catch (err: any) {
        console.error('[FINANCIAL] Failed to update deposit status in PostgreSQL:', err.message);
      }
    })();

    // Credit user deposit balance atomically in PostgreSQL
    const updatedBalance = await WalletService.creditDeposit(
      order.userId,
      order.amountPaise,
      order.utr || order.depositId,
      'Deposit Approved',
      order.depositId
    );

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
      SocketServer.broadcast('WALLET_UPDATE', {
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
  }

  public static rejectDeposit(depositId: string): { success: boolean; message: string; order?: DepositOrder } {
    const order = FinancialService.depositOrders.get(depositId);
    if (!order) return { success: false, message: 'Deposit order not found' };

    if (order.status !== DepositStatus.PENDING) {
      return { success: false, message: `Deposit is already ${order.status}` };
    }

    order.status = DepositStatus.REJECTED;
    order.updatedAt = Date.now();
    FinancialService.depositOrders.set(depositId, order);
    FinancialService.persist();

    // Update PostgreSQL deposits table
    (async () => {
      try {
        const { DatabaseConfig } = await import('../config/db.config');
        const pool = DatabaseConfig.getPool();
        if (pool) {
          await pool.query(
            `UPDATE deposits SET status = 'REJECTED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [order.depositId]
          );
        }
      } catch (err: any) {
        console.error('[FINANCIAL] Failed to update deposit status in PostgreSQL:', err.message);
      }
    })();

    TelegramBotService.sendAlert(
      `❌ *Deposit Rejected*\nOrder: \`${depositId}\`\nUser: \`${order.userId}\`\nAmount: ₹${order.amountRupees.toFixed(2)}`
    );

    return { success: true, message: `Deposit request rejected.`, order };
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

    const rand12 = Math.floor(100000000000 + Math.random() * 900000000000);
    const withdrawalId = `T${rand12}`;

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

  public static approveWithdrawal(withdrawalId: string): { success: boolean; message: string; record?: WithdrawalRecord } {
    const record = FinancialService.withdrawalRecords.get(withdrawalId);
    if (!record) return { success: false, message: 'Withdrawal record not found' };

    if (record.status !== WithdrawalStatus.PENDING && record.status !== WithdrawalStatus.PROCESSING) {
      return { success: false, message: `Withdrawal is already ${record.status}` };
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
  }

  public static async rejectWithdrawal(withdrawalId: string): Promise<{ success: boolean; message: string; record?: WithdrawalRecord }> {
    const record = FinancialService.withdrawalRecords.get(withdrawalId);
    if (!record) return { success: false, message: 'Withdrawal request not found' };

    if (record.status !== WithdrawalStatus.PENDING && record.status !== WithdrawalStatus.PROCESSING) {
      return { success: false, message: `Withdrawal is already ${record.status}` };
    }

    record.status = WithdrawalStatus.REJECTED;
    record.updatedAt = Date.now();
    FinancialService.withdrawalRecords.set(withdrawalId, record);
    FinancialService.persist();

    // Refund debited winnings back to user atomically in PostgreSQL
    const updatedWallet = await WalletService.refundWithdrawal(record.userId, record.amountPaise, withdrawalId);

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
  }
}
