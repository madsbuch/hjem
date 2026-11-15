const invalidCode = 'Scan a Home Assistant access-token QR code.';

/** Home Assistant encodes the raw JWT, not a URL or a login/MFA request. */
export function tokenFromQr(content: string): string {
  const token = content.trim();
  if (token.startsWith('otpauth:'))
    throw new Error(
      'This is a two-factor authentication QR code. Use the QR code under Long-lived access tokens.',
    );
  if (
    token.length > 8192 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  )
    throw new Error(invalidCode);
  try {
    const [header, payload] = token
      .split('.')
      .map((part) => part.replace(/-/g, '+').replace(/_/g, '/'));
    const h = JSON.parse(atob(header));
    const p = JSON.parse(atob(payload));
    if (
      !h ||
      typeof h !== 'object' ||
      h.alg !== 'HS256' ||
      !p ||
      typeof p !== 'object' ||
      typeof p.iss !== 'string' ||
      !p.iss ||
      !Number.isFinite(p.iat) ||
      !Number.isFinite(p.exp)
    )
      throw new Error(invalidCode);
  } catch {
    throw new Error(invalidCode);
  }
  // Signature and expiry are verified by Home Assistant when the user connects.
  return token;
}
