import { NextResponse } from 'next/server';
import { getCryptoDb } from '@/lib/cryptoDb';

export interface ComplianceRow {
  address: string;
  chain: string;
  list_name: string;
  matched_whale_tx_hash: string | null;
  observed_at: string;
}

export function formatComplianceHit(row: ComplianceRow): ComplianceRow {
  return {
    ...row,
    address: row.address.trim(),
    chain: row.chain.trim(),
    list_name: row.list_name.trim(),
    matched_whale_tx_hash: row.matched_whale_tx_hash === null ? null : row.matched_whale_tx_hash.trim(),
  };
}

export async function GET() {
  try {
    const db = getCryptoDb();
    const { rows } = await db.query<ComplianceRow>(
      `SELECT address, chain, list_name, matched_whale_tx_hash, observed_at
       FROM crypto.compliance_hits
       WHERE observed_at > now() - interval '24 hours'
       ORDER BY observed_at DESC
       LIMIT 50`
    );
    return NextResponse.json(
      { compliance: rows.map(formatComplianceHit), timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('crypto/compliance fetch error:', error);
    return NextResponse.json({ compliance: [], error: 'Failed' }, { status: 500 });
  }
}
