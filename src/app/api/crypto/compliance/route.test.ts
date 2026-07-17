import { describe, it, expect } from 'vitest';
import { formatComplianceHit } from './route';

describe('formatComplianceHit', () => {
  it('trims stray whitespace from text fields for clean display', () => {
    const row = {
      address: ' 0x8589427373d6d84e98730d7795d8f6f8731fda0 ',
      chain: 'ETH ',
      list_name: ' ofac_known_starter_list',
      matched_whale_tx_hash: 'abc123',
      observed_at: '2026-07-17T06:00:00Z',
    };
    const result = formatComplianceHit(row as any);
    expect(result.address).toBe('0x8589427373d6d84e98730d7795d8f6f8731fda0');
    expect(result.chain).toBe('ETH');
    expect(result.list_name).toBe('ofac_known_starter_list');
  });

  it('leaves a null matched_whale_tx_hash as null', () => {
    const row = { address: 'addr', chain: 'ETH', list_name: 'list', matched_whale_tx_hash: null, observed_at: '2026-07-17T06:00:00Z' };
    expect(formatComplianceHit(row as any).matched_whale_tx_hash).toBeNull();
  });
});
