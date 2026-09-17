import { Request, Response } from 'express';
import { PaymentService } from './payment.service';
import { WalletValidator } from '../../validators/wallet.validator';
import { ResponseHandler } from '../../utils/responseHandler';

export class DepositController {
  public static initiate(req: Request, res: Response) {
    const validation = WalletValidator.validateDeposit(req.body);
    if (!validation.valid) {
      return ResponseHandler.error(res, validation.message || 'Invalid amount', 400);
    }
    const userId = (req as any).user?.userId || req.body.userId || 'DEFAULT_USER';
    const { amountRupees } = req.body;
    const order = PaymentService.initiateDeposit(userId, amountRupees);
    return ResponseHandler.success(res, order, 'Deposit order created');
  }

  public static submitUtr(req: Request, res: Response) {
    const { depositId, utr } = req.body;
    if (!depositId || !utr) {
      return ResponseHandler.error(res, 'depositId and utr are required', 400);
    }
    const result = PaymentService.submitUtr(depositId, utr);
    if (!result.success) {
      return ResponseHandler.error(res, result.message, 400);
    }
    return ResponseHandler.success(res, result.record, result.message);
  }

  public static getDeposits(req: Request, res: Response) {
    const deposits = PaymentService.getAllDeposits();
    return ResponseHandler.success(res, deposits, 'Deposits retrieved');
  }

  public static approve(req: Request, res: Response) {
    const { depositId } = req.body;
    if (!depositId) return ResponseHandler.error(res, 'depositId is required', 400);
    const result = PaymentService.approveDeposit(depositId);
    if (!result.success) return ResponseHandler.error(res, result.message, 400);
    return ResponseHandler.success(res, result.record, result.message);
  }

  public static reject(req: Request, res: Response) {
    const { depositId } = req.body;
    if (!depositId) return ResponseHandler.error(res, 'depositId is required', 400);
    const result = PaymentService.rejectDeposit(depositId);
    if (!result.success) return ResponseHandler.error(res, result.message, 400);
    return ResponseHandler.success(res, result.record, result.message);
  }
}
