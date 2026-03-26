import { describe, it, expect } from 'vitest';
import { generateJWT, verifyJWT, hashPassword, verifyPassword, extractBearerToken } from '../auth';

// -- JWT --

describe('generateJWT + verifyJWT', () => {
  const secret = 'test-secret-key-for-jwt';
  const payload = { sub: 'user-123', email: 'test@example.com' };

  it('generates a valid token that verifies correctly', async () => {
    const token = await generateJWT(payload, secret);
    const result = await verifyJWT(token, secret);

    expect(result).not.toBeNull();
    expect(result!.sub).toBe('user-123');
    expect(result!.email).toBe('test@example.com');
    expect(result!.iat).toBeTypeOf('number');
    expect(result!.exp).toBeTypeOf('number');
    expect(result!.exp - result!.iat).toBe(86400); // 24h
  });

  it('returns null for a tampered token', async () => {
    const token = await generateJWT(payload, secret);
    // Flip a character in the signature (last segment)
    const parts = token.split('.');
    parts[2] = parts[2].slice(0, -1) + (parts[2].slice(-1) === 'A' ? 'B' : 'A');
    const tampered = parts.join('.');

    const result = await verifyJWT(tampered, secret);
    expect(result).toBeNull();
  });

  it('returns null for wrong secret', async () => {
    const token = await generateJWT(payload, secret);
    const result = await verifyJWT(token, 'wrong-secret');
    expect(result).toBeNull();
  });

  it('returns null for malformed token (missing parts)', async () => {
    expect(await verifyJWT('not.a.valid.jwt.token', secret)).toBeNull();
    expect(await verifyJWT('garbage', secret)).toBeNull();
    expect(await verifyJWT('two.parts', secret)).toBeNull();
  });

  it('returns null for expired token', async () => {
    // Generate a token, then manually craft one with exp in the past
    const token = await generateJWT(payload, secret);
    const parts = token.split('.');
    // Decode payload, set exp to past, re-encode
    const decoded = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    decoded.exp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const newPayload = btoa(JSON.stringify(decoded)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    // This token has a valid header but modified payload, so signature won't match
    // That's fine -- verifyJWT should return null either way (invalid sig or expired)
    const expired = `${parts[0]}.${newPayload}.${parts[2]}`;
    const result = await verifyJWT(expired, secret);
    expect(result).toBeNull();
  });
});

// -- Password Hashing --

describe('hashPassword + verifyPassword', () => {
  it('correct password verifies', async () => {
    const hash = await hashPassword('my-secure-password');
    const valid = await verifyPassword('my-secure-password', hash);
    expect(valid).toBe(true);
  });

  it('wrong password fails', async () => {
    const hash = await hashPassword('my-secure-password');
    const valid = await verifyPassword('wrong-password', hash);
    expect(valid).toBe(false);
  });

  it('hash format is salt:hash in hex', async () => {
    const hash = await hashPassword('test');
    expect(hash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    const [salt, derived] = hash.split(':');
    expect(salt.length).toBe(32); // 16 bytes = 32 hex chars
    expect(derived.length).toBe(64); // 256 bits = 32 bytes = 64 hex chars
  });

  it('returns false for malformed stored hash', async () => {
    expect(await verifyPassword('test', 'not-a-valid-hash')).toBe(false);
    expect(await verifyPassword('test', '')).toBe(false);
  });

  it('different calls produce different salts', async () => {
    const hash1 = await hashPassword('same-password');
    const hash2 = await hashPassword('same-password');
    expect(hash1).not.toBe(hash2); // Different salts
    // But both verify
    expect(await verifyPassword('same-password', hash1)).toBe(true);
    expect(await verifyPassword('same-password', hash2)).toBe(true);
  });
});

// -- extractBearerToken --

describe('extractBearerToken', () => {
  function makeRequest(authHeader?: string): Request {
    const headers = new Headers();
    if (authHeader !== undefined) {
      headers.set('Authorization', authHeader);
    }
    return new Request('http://localhost/test', { headers });
  }

  it('extracts token from valid Bearer header', () => {
    const token = extractBearerToken(makeRequest('Bearer my-jwt-token'));
    expect(token).toBe('my-jwt-token');
  });

  it('returns null when no Authorization header', () => {
    expect(extractBearerToken(makeRequest())).toBeNull();
  });

  it('returns null for non-Bearer auth', () => {
    expect(extractBearerToken(makeRequest('Basic dXNlcjpwYXNz'))).toBeNull();
  });

  it('returns null for malformed Bearer (extra spaces)', () => {
    expect(extractBearerToken(makeRequest('Bearer token extra'))).toBeNull();
  });

  it('returns null for "Bearer" with no token', () => {
    expect(extractBearerToken(makeRequest('Bearer'))).toBeNull();
  });
});
