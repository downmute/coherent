import { createHmac, timingSafeEqual } from 'node:crypto';

function toBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

export function signToken<T extends object>(
  payload: T,
  secret: string,
): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const body = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifyToken<T extends object>(
  token: string,
  secret: string,
): T {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error('Malformed token.');
  }

  const body = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = createHmac('sha256', secret).update(body).digest();
  const actualSignature = Buffer.from(encodedSignature, 'base64url');

  if (
    expectedSignature.length !== actualSignature.length ||
    !timingSafeEqual(expectedSignature, actualSignature)
  ) {
    throw new Error('Invalid token signature.');
  }

  const payload = JSON.parse(fromBase64Url(encodedPayload)) as T & { exp?: number };
  if (typeof payload.exp === 'number' && Date.now() >= payload.exp * 1000) {
    throw new Error('Token has expired.');
  }

  return payload;
}
