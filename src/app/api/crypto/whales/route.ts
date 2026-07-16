import { NextResponse } from 'next/server';
import { getCryptoDb } from '@/lib/cryptoDb';

export interface WhaleRow {
  chain: string;
  tx_hash: string;
  value_usd: number;
  from_address: string | null;
  to_address: string | null;
  observed_at: string;
}

export function formatWhaleTxn(row: WhaleRow): WhaleRow {
  return { ...row, value_usd: Math.round(row.value_usd) };
}

export async function GET() {
  try {
    const db = getCryptoDb();
    const { rows } = await db.query<WhaleRow>(
      `SELECT chain, tx_hash, value_usd::float8 AS value_usd, from_address, to_address, observed_at
       FROM crypto.whale_txns
       WHERE observed_at > now() - interval '24 hours'
       ORDER BY observed_at DESC
       LIMIT 50`
    );
    return NextResponse.json(
      { whales: rows.map(formatWhaleTxn), timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('crypto/whales fetch error:', error);
    return NextResponse.json({ whales: [], error: 'Failed' }, { status: 500 });
  }
}
