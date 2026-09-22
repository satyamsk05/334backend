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

  public static approveDeposit(depositId: string): { success: boolean; message: string; record?: DepositRecord } {
    const res = FinancialService.approveDeposit(depositId);
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

  public static requestWithdrawal(userId: string, amountRupees: number, upiId: string): { success: boolean; message: string; record?: WithdrawalRecord } {
    AuthService.ensureUserExists(userId);
    return FinancialService.requestWithdrawal(userId, amountRupees, upiId);
  }

  public static getAllWithdrawals(): WithdrawalRecord[] {
    return FinancialService.getAllWithdrawals();
  }

  public static approveWithdrawal(withdrawalId: string): { success: boolean; message: string; record?: WithdrawalRecord } {
    return FinancialService.approveWithdrawal(withdrawalId);
  }

  public static rejectWithdrawal(withdrawalId: string): { success: boolean; message: string; record?: WithdrawalRecord } {
    return FinancialService.rejectWithdrawal(withdrawalId);
  }
}
