import { describe, it, expect } from 'vitest';
import { isAuthorized } from './route';

describe('isAuthorized', () => {
  it('accepts a matching bearer token', () => {
    expect(isAuthorized('Bearer secret123', 'secret123')).toBe(true);
  });
  it('rejects a missing header', () => {
    expect(isAuthorized(null, 'secret123')).toBe(false);
  });
  it('rejects a wrong token', () => {
    expect(isAuthorized('Bearer wrong', 'secret123')).toBe(false);
  });
});
