import { describe, it, expect } from 'vitest';
import { groupLatestBySymbol } from './route';

describe('groupLatestBySymbol', () => {
  it('keeps only the most recent row per symbol', () => {
    const rows = [
      { symbol: 'BTC', price_usd: 64000, collected_at: '2026-07-13T10:00:00Z' },
      { symbol: 'BTC', price_usd: 65000, collected_at: '2026-07-13T10:01:00Z' },
      { symbol: 'ETH', price_usd: 3000, collected_at: '2026-07-13T10:00:00Z' },
    ];
    const result = groupLatestBySymbol(rows as any);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.symbol === 'BTC')?.price_usd).toBe(65000);
  });

  it('returns empty array for empty input', () => {
    expect(groupLatestBySymbol([])).toEqual([]);
  });
});
