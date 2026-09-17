export interface WalletBalance {
  depositPaise: number;
  winningPaise: number;
  bonusPaise: number;
  totalPaise: number;
}

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
  private static inMemoryBalances = new Map<string, WalletBalance>();
  private static inMemoryTransactions = new Map<string, WalletTransaction[]>();

  public static getUserBalance(userId: string): WalletBalance {
    if (!WalletLedger.inMemoryBalances.has(userId)) {
      WalletLedger.inMemoryBalances.set(userId, {
        depositPaise: 0,   // ₹0.00 initial real deposit balance
        winningPaise: 0,   // ₹0.00 initial real winnings balance
        bonusPaise: 0,     // ₹0.00 bonus balance
        totalPaise: 0
      });
    }
    return WalletLedger.inMemoryBalances.get(userId)!;
  }

  public static addDepositCash(userId: string, amountPaise: number, utr: string): WalletBalance {
    const current = WalletLedger.getUserBalance(userId);
    const newDeposit = current.depositPaise + amountPaise;
    const newTotal = newDeposit + current.winningPaise + current.bonusPaise;
    const newBal = { ...current, depositPaise: newDeposit, totalPaise: newTotal };

    WalletLedger.inMemoryBalances.set(userId, newBal);
    WalletLedger.recordTransaction(userId, 'DEPOSIT', amountPaise, newTotal, utr || `DEP-${Date.now()}`, 'Cash Deposit');
    return newBal;
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
    const newBal = { ...current, winningPaise: newWinning, totalPaise: newTotal };

    WalletLedger.inMemoryBalances.set(userId, newBal);
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
