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
    const authenticatedUserId = (req as any).user?.userId || (req as any).user?.id;
    if (!authenticatedUserId) {
      return ResponseHandler.error(res, 'Unauthorized: Valid user token required', 401);
    }
    if (req.body?.userId && req.body.userId !== authenticatedUserId) {
      return ResponseHandler.error(res, 'Forbidden: Cannot initiate deposit for another user', 403);
    }
    const { amountRupees } = req.body;
    const order = PaymentService.initiateDeposit(authenticatedUserId, amountRupees);
    return ResponseHandler.success(res, order, 'Deposit order created');
  }

  public static submitUtr(req: Request, res: Response) {
    const authenticatedUserId = (req as any).user?.userId || (req as any).user?.id;
    if (!authenticatedUserId) {
      return ResponseHandler.error(res, 'Unauthorized: Valid user token required', 401);
    }

    const { depositId, utr } = req.body;
    if (!depositId || !utr) {
      return ResponseHandler.error(res, 'depositId and utr are required', 400);
    }

    const order = PaymentService.getDeposit(depositId);
    if (!order) {
      return ResponseHandler.error(res, 'Deposit order not found', 404);
    }

    // Ownership Verification: Only the creator of the deposit can submit its UTR
    if (order.userId !== authenticatedUserId) {
      return ResponseHandler.error(res, 'Forbidden: You do not own this deposit order', 403);
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

  public static async approve(req: Request, res: Response) {
    const { depositId } = req.body;
    const idempKey = (req.headers?.['x-idempotency-key'] as string) || req.body?.idempotencyKey;
    if (!depositId) return ResponseHandler.error(res, 'depositId is required', 400);
    const result = await PaymentService.approveDeposit(depositId, idempKey);
    if (!result.success) return ResponseHandler.error(res, result.message, 400);
    return ResponseHandler.success(res, result.record, result.message);
  }

  public static async reject(req: Request, res: Response) {
    const { depositId } = req.body;
    const idempKey = (req.headers?.['x-idempotency-key'] as string) || req.body?.idempotencyKey;
    if (!depositId) return ResponseHandler.error(res, 'depositId is required', 400);
    const result = await PaymentService.rejectDeposit(depositId, idempKey);
    if (!result.success) return ResponseHandler.error(res, result.message, 400);
    return ResponseHandler.success(res, result.record, result.message);
  }
}
