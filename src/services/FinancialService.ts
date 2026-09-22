import {
  DepositOrder,
  DepositStatus,
  WithdrawalRecord,
  WithdrawalStatus
} from '../models/DepositOrder';
import { WalletLedger } from './WalletLedger';
import { TelegramBotService } from './TelegramBotService';
import { AuthService } from '../modules/auth/auth.service';

export class FinancialService {
  private static depositOrders = new Map<string, DepositOrder>();
  private static withdrawalRecords = new Map<string, WithdrawalRecord>();

  public static initiateDeposit(userId: string, amountRupees: number): DepositOrder {
    AuthService.ensureUserExists(userId);
    const amountPaise = Math.round(amountRupees * 100);
    const depositId = `DEP-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

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

  public static approveDeposit(depositId: string): { success: boolean; message: string; order?: DepositOrder } {
    const order = FinancialService.depositOrders.get(depositId);
    if (!order) return { success: false, message: 'Deposit order not found' };

    if (order.status !== DepositStatus.PENDING) {
      return { success: false, message: `Deposit is already ${order.status}` };
    }

    order.status = DepositStatus.APPROVED;
    order.updatedAt = Date.now();
    FinancialService.depositOrders.set(depositId, order);

    // Credit user deposit balance in integer paise
    WalletLedger.addDepositCash(order.userId, order.amountPaise, order.utr || order.depositId);

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

    TelegramBotService.sendAlert(
      `❌ *Deposit Rejected*\nOrder: \`${depositId}\`\nUser: \`${order.userId}\`\nAmount: ₹${order.amountRupees.toFixed(2)}`
    );

    return { success: true, message: `Deposit request rejected.`, order };
  }

  // Withdrawals Queue
  public static requestWithdrawal(userId: string, amountRupees: number, upiId: string): { success: boolean; message: string; record?: WithdrawalRecord } {
    const amountPaise = Math.round(amountRupees * 100);
    const minPaise = 2500;   // ₹25
    const maxPaise = 500000; // ₹5,000

    if (amountPaise < minPaise) return { success: false, message: 'Minimum withdrawal amount is ₹25' };
    if (amountPaise > maxPaise) return { success: false, message: 'Maximum withdrawal amount is ₹5,000 per request' };

    const wallet = WalletLedger.getUserBalance(userId);
    if (amountPaise > wallet.winningPaise) {
      return { success: false, message: `Insufficient Winnings Balance (Available: ₹${(wallet.winningPaise / 100).toFixed(2)})` };
    }

    // Temporarily debit winnings
    wallet.winningPaise -= amountPaise;
    wallet.totalPaise = wallet.depositPaise + wallet.winningPaise + wallet.bonusPaise;

    const withdrawalId = `WD-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
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

    WalletLedger.recordTransaction(
      userId,
      'WITHDRAWAL',
      amountPaise,
      wallet.totalPaise,
      withdrawalId,
      `Pending Withdrawal to UPI: ${upiId}`
    );

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

  public static approveWithdrawal(withdrawalId: string): { success: boolean; message: string; record?: WithdrawalRecord } {
    const record = FinancialService.withdrawalRecords.get(withdrawalId);
    if (!record) return { success: false, message: 'Withdrawal record not found' };

    if (record.status !== WithdrawalStatus.PENDING) {
      return { success: false, message: `Withdrawal is already ${record.status}` };
    }

    record.status = WithdrawalStatus.APPROVED;
    record.updatedAt = Date.now();
    FinancialService.withdrawalRecords.set(withdrawalId, record);

    TelegramBotService.sendAlert(
      `✅ *Withdrawal Approved & Paid*\nID: \`${withdrawalId}\`\nUser: \`${record.userId}\`\nAmount: ₹${record.amountRupees.toFixed(2)}\nUPI: \`${record.upiId}\``
    );

    return { success: true, message: `Withdrawal ₹${record.amountRupees} approved and paid!`, record };
  }

  public static rejectWithdrawal(withdrawalId: string): { success: boolean; message: string; record?: WithdrawalRecord } {
    const record = FinancialService.withdrawalRecords.get(withdrawalId);
    if (!record) return { success: false, message: 'Withdrawal record not found' };

    if (record.status !== WithdrawalStatus.PENDING) {
      return { success: false, message: `Withdrawal is already ${record.status}` };
    }

    record.status = WithdrawalStatus.REJECTED;
    record.updatedAt = Date.now();
    FinancialService.withdrawalRecords.set(withdrawalId, record);

    // Refund debited winnings back to user
    const wallet = WalletLedger.getUserBalance(record.userId);
    wallet.winningPaise += record.amountPaise;
    wallet.totalPaise = wallet.depositPaise + wallet.winningPaise + wallet.bonusPaise;

    WalletLedger.recordTransaction(
      record.userId,
      'BET_REFUND',
      record.amountPaise,
      wallet.totalPaise,
      `REF-${withdrawalId}`,
      `Withdrawal Rejected & Refunded`
    );

    TelegramBotService.sendAlert(
      `❌ *Withdrawal Rejected & Refunded*\nID: \`${withdrawalId}\`\nUser: \`${record.userId}\`\nAmount: ₹${record.amountRupees.toFixed(2)}`
    );

    return { success: true, message: `Withdrawal rejected and ₹${record.amountRupees} refunded to winnings balance.`, record };
  }
}
