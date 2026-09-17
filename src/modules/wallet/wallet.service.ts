import { Transaction } from '../../database/models/Transaction';
import { Logger } from '../../utils/logger';

export interface WalletBalanceState {
  depositPaise: number;
  winningPaise: number;
  bonusPaise: number;
  totalPaise: number;
}

export class WalletService {
  private static balances = new Map<string, WalletBalanceState>();
  private static transactions = new Map<string, Transaction[]>();

  public static getBalance(userId: string): WalletBalanceState {
    if (!WalletService.balances.has(userId)) {
      WalletService.balances.set(userId, {
        depositPaise: 0,
        winningPaise: 0,
        bonusPaise: 0,
        totalPaise: 0
      });
    }
    return WalletService.balances.get(userId)!;
  }

  public static creditDeposit(userId: string, amountPaise: number, referenceId: string, description: string = 'Deposit Credit'): WalletBalanceState {
    const current = WalletService.getBalance(userId);
    const newDeposit = current.depositPaise + amountPaise;
    const newTotal = newDeposit + current.winningPaise + current.bonusPaise;
    const updated = { ...current, depositPaise: newDeposit, totalPaise: newTotal };

    WalletService.balances.set(userId, updated);
    WalletService.recordTx(userId, 'DEPOSIT', amountPaise, newTotal, referenceId, description);
    Logger.info(`[WALLET] Credited ₹${(amountPaise / 100).toFixed(2)} deposit to ${userId}`);
    return updated;
  }

  public static creditWinnings(userId: string, amountPaise: number, referenceId: string, description: string = 'Win Payout'): WalletBalanceState {
    const current = WalletService.getBalance(userId);
    const newWinnings = current.winningPaise + amountPaise;
    const newTotal = current.depositPaise + newWinnings + current.bonusPaise;
    const updated = { ...current, winningPaise: newWinnings, totalPaise: newTotal };

    WalletService.balances.set(userId, updated);
    WalletService.recordTx(userId, 'WIN_PAYOUT', amountPaise, newTotal, referenceId, description);
    Logger.info(`[WALLET] Credited ₹${(amountPaise / 100).toFixed(2)} winnings to ${userId}`);
    return updated;
  }

  public static creditBonus(userId: string, amountPaise: number, referenceId: string, description: string = 'Bonus Reward'): WalletBalanceState {
    const current = WalletService.getBalance(userId);
    const newBonus = current.bonusPaise + amountPaise;
    const newTotal = current.depositPaise + current.winningPaise + newBonus;
    const updated = { ...current, bonusPaise: newBonus, totalPaise: newTotal };

    WalletService.balances.set(userId, updated);
    WalletService.recordTx(userId, 'BONUS_CREDIT', amountPaise, newTotal, referenceId, description);
    return updated;
  }

  /**
   * Atomic Bet Debit Rule:
   * Debits from `deposit` first -> `winnings` second -> `bonus` third.
   */
  public static debitBet(userId: string, amountPaise: number, referenceId: string, description: string = 'Bet Placement'): {
    success: boolean;
    message?: string;
    debitBreakdown?: { depositDebited: number; winningDebited: number; bonusDebited: number };
    newBalance?: WalletBalanceState;
  } {
    const current = WalletService.getBalance(userId);
    if (current.totalPaise < amountPaise) {
      return { success: false, message: 'Insufficient balance' };
    }

    let remainingToDebit = amountPaise;
    let depositDebited = 0;
    let winningDebited = 0;
    let bonusDebited = 0;

    if (current.depositPaise > 0) {
      depositDebited = Math.min(current.depositPaise, remainingToDebit);
      remainingToDebit -= depositDebited;
    }

    if (remainingToDebit > 0 && current.winningPaise > 0) {
      winningDebited = Math.min(current.winningPaise, remainingToDebit);
      remainingToDebit -= winningDebited;
    }

    if (remainingToDebit > 0 && current.bonusPaise > 0) {
      bonusDebited = Math.min(current.bonusPaise, remainingToDebit);
      remainingToDebit -= bonusDebited;
    }

    if (remainingToDebit > 0) {
      return { success: false, message: 'Insufficient balance across buckets' };
    }

    const newDeposit = current.depositPaise - depositDebited;
    const newWinning = current.winningPaise - winningDebited;
    const newBonus = current.bonusPaise - bonusDebited;
    const newTotal = newDeposit + newWinning + newBonus;

    const newBal = { depositPaise: newDeposit, winningPaise: newWinning, bonusPaise: newBonus, totalPaise: newTotal };
    WalletService.balances.set(userId, newBal);
    WalletService.recordTx(userId, 'BET_DEBIT', amountPaise, newTotal, referenceId, description);

    return {
      success: true,
      debitBreakdown: { depositDebited, winningDebited, bonusDebited },
      newBalance: newBal
    };
  }

  /**
   * Refund Equity Rule:
   * Restores debited funds back to their original bucket source.
   */
  public static refundEquity(userId: string, depositPaise: number, winningPaise: number, bonusPaise: number, referenceId: string, description: string = 'Bet Refund'): WalletBalanceState {
    const current = WalletService.getBalance(userId);
    const totalRefund = depositPaise + winningPaise + bonusPaise;
    const newDeposit = current.depositPaise + depositPaise;
    const newWinning = current.winningPaise + winningPaise;
    const newBonus = current.bonusPaise + bonusPaise;
    const newTotal = newDeposit + newWinning + newBonus;

    const newBal = { depositPaise: newDeposit, winningPaise: newWinning, bonusPaise: newBonus, totalPaise: newTotal };
    WalletService.balances.set(userId, newBal);
    WalletService.recordTx(userId, 'BET_REFUND', totalRefund, newTotal, referenceId, description);
    return newBal;
  }

  public static getTransactions(userId: string): Transaction[] {
    return WalletService.transactions.get(userId) || [];
  }

  public static recordTx(userId: string, type: any, amountPaise: number, balanceAfterPaise: number, referenceId: string, description: string): Transaction {
    const list = WalletService.transactions.get(userId) || [];
    const tx: Transaction = {
      id: `TX-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      userId,
      type,
      amountPaise,
      balanceAfterPaise,
      status: 'SUCCESS',
      referenceId,
      description,
      timestamp: Date.now()
    };
    WalletService.transactions.set(userId, [tx, ...list]);
    return tx;
  }
}
