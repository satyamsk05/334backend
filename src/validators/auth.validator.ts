export class AuthValidator {
  public static validateLogin(body: unknown): { valid: boolean; message?: string } {
    if (!body || typeof body !== 'object') {
      return { valid: false, message: 'Request body is required' };
    }

    const phone = (body as { phone?: unknown }).phone;
    if (typeof phone !== 'string' || !/^\d{10}$/.test(phone.trim())) {
      return { valid: false, message: 'Valid 10-digit phone number is required' };
    }

    return { valid: true };
  }
}
