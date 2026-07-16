import { NextResponse } from 'next/server';
import { getCryptoDb } from '@/lib/cryptoDb';

export interface MarketRow {
  symbol: string;
  price_usd: number;
  volume_24h_usd: number | null;
  change_24h_pct: number | null;
  btc_dominance_pct: number | null;
  fear_greed_index: number | null;
  collected_at: string;
}

export function groupLatestBySymbol(rows: MarketRow[]): MarketRow[] {
  const latest = new Map<string, MarketRow>();
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
    const { rows } = await db.query<MarketRow>(
      `SELECT symbol, price_usd, volume_24h_usd, change_24h_pct,
              btc_dominance_pct, fear_greed_index, collected_at
       FROM crypto.markets
       WHERE collected_at > now() - interval '10 minutes'
       ORDER BY collected_at DESC`
    );
    const markets = groupLatestBySymbol(rows);
    return NextResponse.json(
      { markets, timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('crypto/markets fetch error:', error);
    return NextResponse.json({ markets: [], error: 'Failed' }, { status: 500 });
  }
}
