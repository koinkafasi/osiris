import { NextResponse } from 'next/server';
import { getCryptoDb } from '@/lib/cryptoDb';

export interface LiquidationRow {
  symbol: string;
  side: string;
  value_usd: number;
  price_usd: number;
  observed_at: string;
}

export function formatLiquidation(row: LiquidationRow): LiquidationRow {
  return { ...row, value_usd: Math.round(row.value_usd) };
}

export async function GET() {
  try {
    const db = getCryptoDb();
    const { rows } = await db.query<LiquidationRow>(
      `SELECT symbol, side, value_usd::float8 AS value_usd, price_usd::float8 AS price_usd, observed_at
       FROM crypto.liquidations
       WHERE observed_at > now() - interval '1 hour'
       ORDER BY observed_at DESC
       LIMIT 100`
    );
    return NextResponse.json(
      { liquidations: rows.map(formatLiquidation), timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('crypto/liquidations fetch error:', error);
    return NextResponse.json({ liquidations: [], error: 'Failed' }, { status: 500 });
  }
}
