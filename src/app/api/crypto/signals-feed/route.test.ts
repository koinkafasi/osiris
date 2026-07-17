import { describe, it, expect } from 'vitest';
import { formatSignalRow } from './route';

describe('formatSignalRow', () => {
  it('trims stray whitespace from text fields for clean display', () => {
    const row = { signal_type: ' whale_alert ', severity: 'critical', symbol: ' BTC', message: 'BTC whale transfer: $5,000,000 ', created_at: '2026-07-17T06:00:00Z' };
    const result = formatSignalRow(row as any);
    expect(result.signal_type).toBe('whale_alert');
    expect(result.symbol).toBe('BTC');
    expect(result.message).toBe('BTC whale transfer: $5,000,000');
  });

  it('leaves a null symbol as null', () => {
    const row = { signal_type: 'liquidation_cascade', severity: 'critical', symbol: null, message: 'cascade', created_at: '2026-07-17T06:00:00Z' };
    expect(formatSignalRow(row as any).symbol).toBeNull();
  });
});
