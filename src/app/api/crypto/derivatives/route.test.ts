import { describe, it, expect } from 'vitest';
import { groupLatestBySymbol } from './route';

describe('groupLatestBySymbol (derivatives)', () => {
  it('keeps only the most recent row per symbol', () => {
    const rows = [
      { symbol: 'BTC', funding_rate: 0.0001, mark_price: 64000, open_interest_usd: 1000, collected_at: '2026-07-16T10:00:00Z' },
      { symbol: 'BTC', funding_rate: 0.0002, mark_price: 65000, open_interest_usd: 1100, collected_at: '2026-07-16T10:01:00Z' },
    ];
    const result = groupLatestBySymbol(rows as any);
    expect(result).toHaveLength(1);
    expect(result[0].funding_rate).toBe(0.0002);
  });
});
