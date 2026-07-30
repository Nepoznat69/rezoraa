import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyMetaSignature } from '../src/lib/security.js';

describe('Meta webhook potpis', () => {
  it('prihvata samo ispravan HMAC potpis', () => {
    const body = Buffer.from('{"test":true}');
    const secret = 'tajna';
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect(verifyMetaSignature(body, signature, secret)).toBe(true);
    expect(verifyMetaSignature(body, 'sha256=pogresno', secret)).toBe(false);
  });
});
