export class AuthValidator {
  public static validateLogin(body: any): { valid: boolean; message?: string } {
    if (!body.phone || typeof body.phone !== 'string' || body.phone.trim().length < 10) {
      return { valid: false, message: 'Valid 10-digit phone number is required' };
    }
    return { valid: true };
  }
}
