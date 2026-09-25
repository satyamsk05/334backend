import { FinancialService } from '../../services/FinancialService';
import { DepositOrder, WithdrawalRecord } from '../../models/DepositOrder';
import { AuthService } from '../auth/auth.service';

export type DepositRecord = DepositOrder;
export { WithdrawalRecord };

export class PaymentService {
  public static initiateDeposit(userId: string, amountRupees: number): DepositRecord {
    AuthService.ensureUserExists(userId);
    return FinancialService.initiateDeposit(userId, amountRupees);
  }

  public static submitUtr(depositId: string, utr: string): { success: boolean; message: string; record?: DepositRecord } {
    const res = FinancialService.submitUtr(depositId, utr);
    return {
      success: res.success,
      message: res.message,
      record: res.order
    };
  }

  public static getDeposit(depositId: string): DepositRecord | undefined {
    return FinancialService.getDeposit(depositId);
  }

  public static getAllDeposits(): DepositRecord[] {
    return FinancialService.getAllDeposits();
  }

  public static async approveDeposit(depositId: string): Promise<{ success: boolean; message: string; record?: DepositRecord }> {
    const res = await FinancialService.approveDeposit(depositId);
    return {
      success: res.success,
      message: res.message,
      record: res.order
    };
  }

  public static rejectDeposit(depositId: string): { success: boolean; message: string; record?: DepositRecord } {
    const res = FinancialService.rejectDeposit(depositId);
    return {
      success: res.success,
      message: res.message,
      record: res.order
    };
  }

  public static async requestWithdrawal(userId: string, amountRupees: number, upiId: string): Promise<{ success: boolean; message: string; record?: WithdrawalRecord }> {
    AuthService.ensureUserExists(userId);
    return await FinancialService.requestWithdrawal(userId, amountRupees, upiId);
  }

  public static getAllWithdrawals(): WithdrawalRecord[] {
    return FinancialService.getAllWithdrawals();
  }

  public static processWithdrawal(withdrawalId: string): { success: boolean; message: string; record?: WithdrawalRecord } {
    return FinancialService.processWithdrawal(withdrawalId);
  }

  public static approveWithdrawal(withdrawalId: string): { success: boolean; message: string; record?: WithdrawalRecord } {
    return FinancialService.approveWithdrawal(withdrawalId);
  }

  public static async rejectWithdrawal(withdrawalId: string): Promise<{ success: boolean; message: string; record?: WithdrawalRecord }> {
    return await FinancialService.rejectWithdrawal(withdrawalId);
  }
}
