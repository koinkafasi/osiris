import { NextResponse } from 'next/server';
import { getCryptoDb } from '@/lib/cryptoDb';

export interface StablecoinRow {
  symbol: string;
  circulating_usd: number;
  net_change_usd: number | null;
  collected_at: string;
}

export function formatStablecoinRow(row: StablecoinRow): StablecoinRow {
  return {
    ...row,
    circulating_usd: Math.round(row.circulating_usd),
    net_change_usd: row.net_change_usd === null ? null : Math.round(row.net_change_usd),
  };
}

export async function GET() {
  try {
    const db = getCryptoDb();
    const { rows } = await db.query<StablecoinRow>(
      `SELECT symbol, circulating_usd::float8 AS circulating_usd, net_change_usd::float8 AS net_change_usd, collected_at
       FROM crypto.stablecoin_flows
       WHERE collected_at > now() - interval '15 minutes'
       ORDER BY circulating_usd DESC`
    );
    return NextResponse.json(
      { stablecoins: rows.map(formatStablecoinRow), timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('crypto/stablecoins fetch error:', error);
    return NextResponse.json({ stablecoins: [], error: 'Failed' }, { status: 500 });
  }
}
