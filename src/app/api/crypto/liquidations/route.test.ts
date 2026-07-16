import { describe, it, expect } from 'vitest';
import { formatLiquidation } from './route';

describe('formatLiquidation', () => {
  it('rounds value_usd to nearest dollar', () => {
    const row = { symbol: 'BTC', side: 'long', value_usd: 138.678, price_usd: 9910.5, observed_at: '2026-07-16T10:00:00Z' };
    expect(formatLiquidation(row as any).value_usd).toBe(139);
  });
});
