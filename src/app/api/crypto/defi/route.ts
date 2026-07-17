import { NextResponse } from 'next/server';
import { getCryptoDb } from '@/lib/cryptoDb';

export interface DefiRow {
  protocol: string;
  chain: string | null;
  category: string | null;
  tvl_usd: number;
  collected_at: string;
}

export function formatDefiRow(row: DefiRow): DefiRow {
  return { ...row, tvl_usd: Math.round(row.tvl_usd) };
}

export async function GET() {
  try {
    const db = getCryptoDb();
    const { rows } = await db.query<DefiRow>(
      `SELECT protocol, chain, category, tvl_usd::float8 AS tvl_usd, collected_at
       FROM crypto.defi_tvl
       WHERE collected_at > now() - interval '15 minutes'
       ORDER BY tvl_usd DESC`
    );
    return NextResponse.json(
      { defi: rows.map(formatDefiRow), timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('crypto/defi fetch error:', error);
    return NextResponse.json({ defi: [], error: 'Failed' }, { status: 500 });
  }
}
