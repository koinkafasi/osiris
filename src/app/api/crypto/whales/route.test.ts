import { describe, it, expect } from 'vitest';
import { formatWhaleTxn } from './route';

describe('formatWhaleTxn', () => {
  it('rounds value_usd to nearest dollar for display', () => {
    const row = { chain: 'BTC', tx_hash: 'abc', value_usd: 512345.678, from_address: null, to_address: 'x', observed_at: '2026-07-13T10:00:00Z' };
    expect(formatWhaleTxn(row as any).value_usd).toBe(512346);
  });
});
