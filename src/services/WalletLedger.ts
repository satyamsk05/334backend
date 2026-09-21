import { WalletService, WalletBalanceState } from '../modules/wallet/wallet.service';

export type WalletBalance = WalletBalanceState;

export interface WalletTransaction {
  id: string;
  userId: string;
  type: string;
  amountPaise: number;
  balanceAfterPaise: number;
  status: string;
  referenceId: string;
  description: string;
  timestamp: number;
}

export class WalletLedger {
  private static inMemoryTransactions = new Map<string, WalletTransaction[]>();

  public static getUserBalance(userId: string): WalletBalance {
    return WalletService.getBalance(userId);
  }

  public static addDepositCash(userId: string, amountPaise: number, utr: string): WalletBalance {
    return WalletService.creditDeposit(userId, amountPaise, utr || `DEP-${Date.now()}`, 'Cash Deposit');
  }

  // Alias for backward compatibility if called as addDemoCash
  public static addDemoCash(userId: string, amountPaise: number, utr: string): WalletBalance {
    return WalletLedger.addDepositCash(userId, amountPaise, utr);
  }

  public static requestWithdrawal(userId: string, amountPaise: number, upiId: string): { success: boolean; message: string } {
    const minPaise = 2500;   // ₹25
    const maxPaise = 500000; // ₹5,000

    if (amountPaise < minPaise) return { success: false, message: 'Minimum withdrawal amount is ₹25' };
    if (amountPaise > maxPaise) return { success: false, message: 'Maximum withdrawal amount is ₹5,000 per request' };

    const current = WalletLedger.getUserBalance(userId);
    if (amountPaise > current.winningPaise) {
      return { success: false, message: `Insufficient Winnings Balance (Available: ₹${(current.winningPaise / 100).toFixed(2)})` };
    }

    const newWinning = current.winningPaise - amountPaise;
    const newTotal = current.depositPaise + newWinning + current.bonusPaise;
    current.winningPaise = newWinning;
    current.totalPaise = newTotal;

    WalletLedger.recordTransaction(userId, 'WITHDRAWAL', amountPaise, newTotal, `WD-${Date.now()}`, `Withdrawal to UPI: ${upiId}`);

    return { success: true, message: `Withdrawal request of ₹${(amountPaise / 100).toFixed(2)} submitted successfully!` };
  }

  public static getTransactions(userId: string): WalletTransaction[] {
    return WalletLedger.inMemoryTransactions.get(userId) || [];
  }

  public static recordTransaction(userId: string, type: string, amountPaise: number, balanceAfter: number, refId: string, desc: string): void {
    const txList = WalletLedger.inMemoryTransactions.get(userId) || [];
    const tx: WalletTransaction = {
      id: `TX-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      userId,
      type,
      amountPaise,
      balanceAfterPaise: balanceAfter,
      status: 'SUCCESS',
      referenceId: refId,
      description: desc,
      timestamp: Date.now()
    };
    WalletLedger.inMemoryTransactions.set(userId, [tx, ...txList]);
  }
}
