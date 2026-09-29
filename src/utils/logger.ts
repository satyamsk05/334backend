const SENSITIVE_KEY_REGEX =
  /^(password|pass|secret|admin_?secret|token|jwt|access_?token|refresh_?token|auth_?token|otp|code|auth_?code|pin|upi|upi_?id|vpa|payout_?address|bank_?account|account_?number|cvv|pan)$/i;

const JWT_REGEX = /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g;
const BEARER_REGEX = /Bearer\s+[a-zA-Z0-9._\-+=]{15,}/gi;
const DB_URL_PWD_REGEX = /(:\/\/[^:]+:)[^@]+(@)/g;
const PHONE_REGEX = /\b(\+?91[\s-]?)?([6-9]\d{5})(\d{4})\b/g;
const UPI_REGEX = /\b[a-zA-Z0-9._\-]{3,}@(okhdfcbank|okaxis|oksbi|okicici|paytm|upi|ybl|ibl|axl|apl|barodampay|rbl)\b/gi;

export function redactString(str: string): string {
  if (typeof str !== 'string') return str;
  return str
    .replace(JWT_REGEX, '[REDACTED_JWT]')
    .replace(BEARER_REGEX, 'Bearer [REDACTED_TOKEN]')
    .replace(DB_URL_PWD_REGEX, '$1***$2')
    .replace(PHONE_REGEX, '$1******$3')
    .replace(UPI_REGEX, '***@$1');
}

export function redact(data: any, seen: WeakSet<object> = new WeakSet()): any {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') return redactString(data);
  if (typeof data === 'number' || typeof data === 'boolean') return data;

  if (data instanceof Error) {
    return {
      name: data.name,
      message: redactString(data.message),
      stack: data.stack ? redactString(data.stack) : undefined
    };
  }

  if (typeof data === 'object') {
    if (seen.has(data)) return '[CIRCULAR]';
    seen.add(data);

    if (Array.isArray(data)) {
      return data.map((item) => redact(item, seen));
    }

    const redactedObj: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (SENSITIVE_KEY_REGEX.test(key)) {
        redactedObj[key] = '[REDACTED]';
      } else if (key.toLowerCase().includes('phone') || key.toLowerCase().includes('mobile')) {
        if (typeof value === 'string' && value.length >= 4) {
          redactedObj[key] = `******${value.slice(-4)}`;
        } else {
          redactedObj[key] = '[REDACTED]';
        }
      } else {
        redactedObj[key] = redact(value, seen);
      }
    }
    return redactedObj;
  }

  return data;
}

export class Logger {
  public static info(message: string, ...meta: any[]): void {
    const cleanMsg = redactString(message);
    const cleanMeta = meta.map((m) => redact(m));
    console.log(`[INFO] [${new Date().toISOString()}] ${cleanMsg}`, ...cleanMeta);
  }

  public static warn(message: string, ...meta: any[]): void {
    const cleanMsg = redactString(message);
    const cleanMeta = meta.map((m) => redact(m));
    console.warn(`[WARN] [${new Date().toISOString()}] ${cleanMsg}`, ...cleanMeta);
  }

  public static error(message: string, ...meta: any[]): void {
    const cleanMsg = redactString(message);
    const cleanMeta = meta.map((m) => redact(m));
    console.error(`[ERROR] [${new Date().toISOString()}] ${cleanMsg}`, ...cleanMeta);
  }
}
