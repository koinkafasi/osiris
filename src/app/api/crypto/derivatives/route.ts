import { NextResponse } from 'next/server';
import { getCryptoDb } from '@/lib/cryptoDb';

export interface DerivativeRow {
  symbol: string;
  funding_rate: number | null;
  mark_price: number;
  open_interest_usd: number | null;
  collected_at: string;
}

export function groupLatestBySymbol(rows: DerivativeRow[]): DerivativeRow[] {
  const latest = new Map<string, DerivativeRow>();
  for (const row of rows) {
    const existing = latest.get(row.symbol);
    if (!existing || new Date(row.collected_at) > new Date(existing.collected_at)) {
      latest.set(row.symbol, row);
    }
  }
  return Array.from(latest.values());
}

export async function GET() {
  try {
    const db = getCryptoDb();
    const { rows } = await db.query<DerivativeRow>(
      `SELECT symbol, funding_rate, mark_price::float8 AS mark_price,
              open_interest_usd::float8 AS open_interest_usd, collected_at
       FROM crypto.derivatives
       WHERE collected_at > now() - interval '20 minutes'
       ORDER BY collected_at DESC`
    );
    const derivatives = groupLatestBySymbol(rows);
    return NextResponse.json(
      { derivatives, timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('crypto/derivatives fetch error:', error);
    return NextResponse.json({ derivatives: [], error: 'Failed' }, { status: 500 });
  }
}
