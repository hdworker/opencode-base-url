import { describe, it, expect } from 'vitest';
import { extractApiKey, validateApiKey } from '../src/auth';

describe('extractApiKey', () => {
  it('extracts from X-Api-Key header', () => {
    expect(extractApiKey({ 'x-api-key': 'sk-test-key-32-chars-minimum-here' })).toBe('sk-test-key-32-chars-minimum-here');
  });

  it('extracts from Authorization Bearer header', () => {
    expect(extractApiKey({ 'authorization': 'Bearer sk-test-key-32-chars-minimum-here' })).toBe('sk-test-key-32-chars-minimum-here');
  });

  it('prefers X-Api-Key over Authorization', () => {
    const result = extractApiKey({
      'x-api-key': 'sk-primary',
      'authorization': 'Bearer sk-secondary',
    });
    expect(result).toBe('sk-primary');
  });

  it('returns null when no key present', () => {
    expect(extractApiKey({})).toBeNull();
  });

  it('trims whitespace from Bearer token', () => {
    expect(extractApiKey({ 'authorization': 'Bearer   sk-key  ' })).toBe('sk-key');
  });
});

describe('validateApiKey', () => {
  it('returns null for valid key (32+ chars)', () => {
    expect(validateApiKey('a'.repeat(32))).toBeNull();
    expect(validateApiKey('a'.repeat(64))).toBeNull();
  });

  it('returns error for missing key', () => {
    const err = validateApiKey(null);
    expect(err).not.toBeNull();
    expect(err!.status).toBe(401);
    expect(err!.body).toHaveProperty('error');
  });

  it('returns error for short key (< 32 chars)', () => {
    const err = validateApiKey('short-key');
    expect(err).not.toBeNull();
    expect(err!.status).toBe(401);
  });
});
