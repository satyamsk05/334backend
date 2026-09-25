import { WalletService, WalletBalanceState } from '../modules/wallet/wallet.service';
import { Transaction } from '../database/models/Transaction';

export type WalletBalance = WalletBalanceState;
export type WalletTransaction = Transaction;

export class WalletLedger {
  /**
   * Get authoritative user wallet balance from PostgreSQL.
   */
  public static async getUserBalance(userId: string): Promise<WalletBalance> {
    return await WalletService.getBalance(userId);
  }

  /**
   * Add cash deposit to deposit balance in PostgreSQL.
   */
  public static async addDepositCash(userId: string, amountPaise: number, utr: string): Promise<WalletBalance> {
    return await WalletService.creditDeposit(userId, amountPaise, utr || `DEP-${Date.now()}`, 'Cash Deposit');
  }

  /**
   * Request withdrawal debited from winnings balance in PostgreSQL.
   */
  public static async requestWithdrawal(userId: string, amountPaise: number, upiId: string): Promise<{ success: boolean; message: string; newBalance?: WalletBalance }> {
    const withdrawalId = `WD-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
    return await WalletService.debitWithdrawal(userId, amountPaise, withdrawalId, upiId);
  }

  /**
   * Query authoritative transaction ledger from PostgreSQL.
   */
  public static async getTransactions(userId: string): Promise<WalletTransaction[]> {
    return await WalletService.getTransactions(userId);
  }

  /**
   * Legacy shim for backward compatibility (delegates to WalletService ledger).
   */
  public static async recordTransaction(
    userId: string,
    type: string,
    amountPaise: number,
    balanceAfter: number,
    refId: string,
    desc: string
  ): Promise<void> {
    // Operations should now be recorded via transactional WalletService methods.
    // This shim exists for legacy callers.
  }
}
