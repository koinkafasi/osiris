import { describe, it, expect } from 'vitest';
import { formatGeoNode } from './route';

describe('formatGeoNode', () => {
  it('rounds metric_value to 2 decimal places for display', () => {
    const row = { kind: 'mining_hashrate', country: 'United States', metric_value: 37.849999, collected_at: '2026-07-17T06:21:46Z' };
    expect(formatGeoNode(row as any).metric_value).toBe(37.85);
  });

  it('leaves an already-clean value unchanged', () => {
    const row = { kind: 'mining_hashrate', country: 'China', metric_value: 21.1, collected_at: '2026-07-17T06:21:46Z' };
    expect(formatGeoNode(row as any).metric_value).toBe(21.1);
  });
});
