import { NextResponse } from 'next/server';
import { getCryptoDb } from '@/lib/cryptoDb';

export interface SignalRow {
  signal_type: string;
  severity: string;
  symbol: string | null;
  message: string;
  created_at: string;
}

export function formatSignalRow(row: SignalRow): SignalRow {
  return {
    ...row,
    signal_type: row.signal_type.trim(),
    symbol: row.symbol === null ? null : row.symbol.trim(),
    message: row.message.trim(),
  };
}

export async function GET() {
  try {
    const db = getCryptoDb();
    const { rows } = await db.query<SignalRow>(
      `SELECT signal_type, severity, symbol, message, created_at
       FROM crypto.signals
       WHERE severity = 'critical' AND created_at > now() - interval '24 hours'
       ORDER BY created_at DESC
       LIMIT 20`
    );
    return NextResponse.json(
      { signals: rows.map(formatSignalRow), timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('crypto/signals-feed fetch error:', error);
    return NextResponse.json({ signals: [], error: 'Failed' }, { status: 500 });
  }
}
