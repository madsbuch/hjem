import { describe, expect, it } from 'vitest';
import { tokenFromQr } from '../src/lib/token-qr';

const part = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
const token = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ iss: 'test-only', iat: 1, exp: 9999999999 })}.test_signature`;

describe('Home Assistant token QR format', () => {
  it('accepts a raw Home Assistant JWT without changing it', () => {
    expect(tokenFromQr(`  ${token}\n`)).toBe(token);
  });
  it('identifies MFA QR codes without returning the secret', () => {
    expect(() => tokenFromQr('otpauth://totp/Home?secret=TEST_ONLY')).toThrow(
      'two-factor authentication',
    );
  });
  it.each([
    'https://example.com',
    '{"access_token":"secret"}',
    '',
    'a'.repeat(9000),
    'aa.bb.cc',
    `${part({ alg: 'none' })}.${part({ iss: 'x', iat: 1, exp: 2 })}.x`,
    `${part({ alg: 'HS256' })}.${part({ iss: 'x' })}.x`,
  ])(
    'rejects unrelated or malformed contents without reflecting them',
    (value) => {
      expect(() => tokenFromQr(value)).toThrow(
        'Scan a Home Assistant access-token QR code.',
      );
    },
  );
});
