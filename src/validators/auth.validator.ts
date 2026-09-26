export class AuthValidator {
  public static validateLogin(body: unknown): { valid: boolean; message?: string } {
    if (!body || typeof body !== 'object') {
      return { valid: false, message: 'Request body is required' };
    }

    const phone = (body as { phone?: unknown }).phone;
    if (typeof phone !== 'string') {
      return { valid: false, message: 'Phone number is required' };
    }

    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) {
      return { valid: false, message: 'Valid 10-15 digit phone number is required' };
    }

    return { valid: true };
  }
}

