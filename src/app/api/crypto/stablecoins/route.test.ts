import { describe, it, expect } from 'vitest';
import { formatStablecoinRow } from './route';

describe('formatStablecoinRow', () => {
  it('rounds circulating_usd and net_change_usd to nearest dollar for display', () => {
    const row = { symbol: 'USDT', circulating_usd: 118765432109.678, net_change_usd: -123456.321, collected_at: '2026-07-17T06:31:32Z' };
    const result = formatStablecoinRow(row as any);
    expect(result.circulating_usd).toBe(118765432110);
    expect(result.net_change_usd).toBe(-123456);
  });

  it('leaves a null net_change_usd as null', () => {
    const row = { symbol: 'USDT', circulating_usd: 100.4, net_change_usd: null, collected_at: '2026-07-17T06:31:32Z' };
    expect(formatStablecoinRow(row as any).net_change_usd).toBeNull();
  });
});
