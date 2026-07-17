import { describe, it, expect } from 'vitest';
import { formatDefiRow } from './route';

describe('formatDefiRow', () => {
  it('rounds tvl_usd to nearest dollar for display', () => {
    const row = { protocol: 'Lido', chain: 'Ethereum', category: 'Liquid Staking', tvl_usd: 34567890.678, collected_at: '2026-07-17T06:31:32Z' };
    expect(formatDefiRow(row as any).tvl_usd).toBe(34567891);
  });
});
