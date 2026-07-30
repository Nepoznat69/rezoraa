import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyMetaSignature(rawBody: Buffer, signature: string, appSecret: string): boolean {
  if (!signature.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  return safeEqual(expected, signature);
}

export function normalizePhone(phone: string): string {
  return phone.replace(/@c\.us$/i, '').replace(/\D/g, '');
}

