export class WalletValidator {
  public static validateDeposit(body: any): { valid: boolean; message?: string } {
    if (!body.amountRupees || typeof body.amountRupees !== 'number' || body.amountRupees <= 0) {
      return { valid: false, message: 'Valid positive amount in Rupees is required' };
    }
    return { valid: true };
  }

  public static validateWithdrawal(body: any): { valid: boolean; message?: string } {
    if (!body.amountRupees || typeof body.amountRupees !== 'number' || body.amountRupees < 25) {
      return { valid: false, message: 'Minimum withdrawal amount is ₹25' };
    }
    if (!body.upiId || typeof body.upiId !== 'string' || !body.upiId.includes('@')) {
      return { valid: false, message: 'Valid VPA / UPI ID is required (e.g. name@upi)' };
    }
    return { valid: true };
  }
}
