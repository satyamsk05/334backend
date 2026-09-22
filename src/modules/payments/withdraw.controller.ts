import { Request, Response } from 'express';
import { PaymentService } from './payment.service';
import { WalletValidator } from '../../validators/wallet.validator';
import { ResponseHandler } from '../../utils/responseHandler';

export class WithdrawController {
  public static request(req: Request, res: Response) {
    const validation = WalletValidator.validateWithdrawal(req.body);
    if (!validation.valid) {
      return ResponseHandler.error(res, validation.message || 'Invalid withdrawal parameters', 400);
    }
    const authenticatedUserId = (req as any).user?.userId;
    if (!authenticatedUserId) {
      return ResponseHandler.error(res, 'Unauthorized: Valid user token required', 401);
    }
    const { amountRupees, upiId } = req.body;
    const result = PaymentService.requestWithdrawal(authenticatedUserId, amountRupees, upiId);
    if (!result.success) {
      return ResponseHandler.error(res, result.message, 400);
    }
    return ResponseHandler.success(res, result.record, result.message);
  }

  public static getWithdrawals(req: Request, res: Response) {
    const records = PaymentService.getAllWithdrawals();
    return ResponseHandler.success(res, records, 'Withdrawal requests retrieved');
  }

  public static approve(req: Request, res: Response) {
    const { withdrawalId } = req.body;
    if (!withdrawalId) return ResponseHandler.error(res, 'withdrawalId is required', 400);
    const result = PaymentService.approveWithdrawal(withdrawalId);
    if (!result.success) return ResponseHandler.error(res, result.message, 400);
    return ResponseHandler.success(res, result.record, result.message);
  }

  public static reject(req: Request, res: Response) {
    const { withdrawalId } = req.body;
    if (!withdrawalId) return ResponseHandler.error(res, 'withdrawalId is required', 400);
    const result = PaymentService.rejectWithdrawal(withdrawalId);
    if (!result.success) return ResponseHandler.error(res, result.message, 400);
    return ResponseHandler.success(res, result.record, result.message);
  }
}
