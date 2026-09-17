import { WalletService } from '../wallet/wallet.service';
import { Logger } from '../../utils/logger';

export interface DepositRecord {
  depositId: string;
  userId: string;
  amountRupees: number;
  amountPaise: number;
  utr?: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdAt: number;
  updatedAt: number;
}

export interface WithdrawalRecord {
  withdrawalId: string;
  userId: string;
  amountRupees: number;
  amountPaise: number;
  upiId: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdAt: number;
  updatedAt: number;
}

export class PaymentService {
  private static deposits = new Map<string, DepositRecord>();
  private static withdrawals = new Map<string, WithdrawalRecord>();

  public static initiateDeposit(userId: string, amountRupees: number): DepositRecord {
    const amountPaise = Math.round(amountRupees * 100);
    const depositId = `DEP-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

    const order: DepositRecord = {
      depositId,
      userId,
      amountRupees,
      amountPaise,
      status: 'PENDING',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    PaymentService.deposits.set(depositId, order);
    Logger.info(`[PAYMENT] Initiated deposit ${depositId} for user ${userId} of ₹${amountRupees}`);
    return order;
  }

  public static submitUtr(depositId: string, utr: string): { success: boolean; message: string; record?: DepositRecord } {
    const record = PaymentService.deposits.get(depositId);
    if (!record) return { success: false, message: 'Deposit request not found' };

    if (!utr || utr.trim().length < 6) {
      return { success: false, message: 'Please provide a valid UTR / Ref string' };
    }

    record.utr = utr.trim();
    record.updatedAt = Date.now();
    PaymentService.deposits.set(depositId, record);
    return { success: true, message: 'UTR submitted for admin verification', record };
  }

  public static getDeposit(depositId: string): DepositRecord | undefined {
    return PaymentService.deposits.get(depositId);
  }

  public static getAllDeposits(): DepositRecord[] {
    return Array.from(PaymentService.deposits.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  public static approveDeposit(depositId: string): { success: boolean; message: string; record?: DepositRecord } {
    const record = PaymentService.deposits.get(depositId);
    if (!record) return { success: false, message: 'Deposit record not found' };
    if (record.status !== 'PENDING') return { success: false, message: `Deposit is already ${record.status}` };

    record.status = 'APPROVED';
    record.updatedAt = Date.now();
    PaymentService.deposits.set(depositId, record);

    WalletService.creditDeposit(record.userId, record.amountPaise, record.utr || record.depositId, 'Deposit Approved');
    return { success: true, message: `Deposit of ₹${record.amountRupees} approved and credited.`, record };
  }

  public static rejectDeposit(depositId: string): { success: boolean; message: string; record?: DepositRecord } {
    const record = PaymentService.deposits.get(depositId);
    if (!record) return { success: false, message: 'Deposit record not found' };
    if (record.status !== 'PENDING') return { success: false, message: `Deposit is already ${record.status}` };

    record.status = 'REJECTED';
    record.updatedAt = Date.now();
    PaymentService.deposits.set(depositId, record);
    return { success: true, message: 'Deposit request rejected.', record };
  }

  // Withdrawal Pipeline
  public static requestWithdrawal(userId: string, amountRupees: number, upiId: string): { success: boolean; message: string; record?: WithdrawalRecord } {
    const amountPaise = Math.round(amountRupees * 100);
    const minPaise = 2500;   // ₹25
    const maxPaise = 500000; // ₹5,000

    if (amountPaise < minPaise) return { success: false, message: 'Minimum withdrawal amount is ₹25' };
    if (amountPaise > maxPaise) return { success: false, message: 'Maximum withdrawal amount is ₹5,000' };

    const balance = WalletService.getBalance(userId);
    if (amountPaise > balance.winningPaise) {
      return { success: false, message: `Insufficient Winnings Balance (Available: ₹${(balance.winningPaise / 100).toFixed(2)})` };
    }

    // Debit winnings balance for pending request
    balance.winningPaise -= amountPaise;
    balance.totalPaise = balance.depositPaise + balance.winningPaise + balance.bonusPaise;

    const withdrawalId = `WD-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
    const record: WithdrawalRecord = {
      withdrawalId,
      userId,
      amountRupees,
      amountPaise,
      upiId,
      status: 'PENDING',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    PaymentService.withdrawals.set(withdrawalId, record);
    WalletService.recordTx(userId, 'WITHDRAWAL', amountPaise, balance.totalPaise, withdrawalId, `Pending Withdrawal to UPI: ${upiId}`);

    return { success: true, message: `Withdrawal request of ₹${amountRupees.toFixed(2)} submitted for admin review!`, record };
  }

  public static getAllWithdrawals(): WithdrawalRecord[] {
    return Array.from(PaymentService.withdrawals.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  public static approveWithdrawal(withdrawalId: string): { success: boolean; message: string; record?: WithdrawalRecord } {
    const record = PaymentService.withdrawals.get(withdrawalId);
    if (!record) return { success: false, message: 'Withdrawal request not found' };
    if (record.status !== 'PENDING') return { success: false, message: `Withdrawal is already ${record.status}` };

    record.status = 'APPROVED';
    record.updatedAt = Date.now();
    PaymentService.withdrawals.set(withdrawalId, record);
    return { success: true, message: `Withdrawal of ₹${record.amountRupees} approved and paid out!`, record };
  }

  public static rejectWithdrawal(withdrawalId: string): { success: boolean; message: string; record?: WithdrawalRecord } {
    const record = PaymentService.withdrawals.get(withdrawalId);
    if (!record) return { success: false, message: 'Withdrawal request not found' };
    if (record.status !== 'PENDING') return { success: false, message: `Withdrawal is already ${record.status}` };

    record.status = 'REJECTED';
    record.updatedAt = Date.now();
    PaymentService.withdrawals.set(withdrawalId, record);

    // Refund debited winnings
    const balance = WalletService.getBalance(record.userId);
    balance.winningPaise += record.amountPaise;
    balance.totalPaise = balance.depositPaise + balance.winningPaise + balance.bonusPaise;
    WalletService.recordTx(record.userId, 'BET_REFUND', record.amountPaise, balance.totalPaise, `REF-${withdrawalId}`, 'Withdrawal Rejected & Refunded');

    return { success: true, message: 'Withdrawal rejected & refunded to winnings.', record };
  }
}
