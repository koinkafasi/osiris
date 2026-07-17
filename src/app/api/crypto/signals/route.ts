import { NextResponse } from 'next/server';
import { getCryptoDb } from '@/lib/cryptoDb';

export interface SignalRow {
  signal_type: string;
  severity: string;
  symbol: string | null;
  message: string;
  payload: unknown;
  created_at: string;
}

export function isAuthorized(authHeader: string | null, expectedKey: string): boolean {
  if (!authHeader) return false;
  const match = authHeader.match(/^Bearer\s+(.+)$/);
  return !!match && match[1] === expectedKey;
}

export async function GET(req: Request) {
  const expectedKey = process.env.CRYPTO_SIGNALS_API_KEY;
  if (!expectedKey) {
    return NextResponse.json({ error: 'Signals API not configured' }, { status: 503 });
  }
  if (!isAuthorized(req.headers.get('authorization'), expectedKey)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const db = getCryptoDb();
    const { rows } = await db.query<SignalRow>(
      `SELECT signal_type, severity, symbol, message, payload, created_at
       FROM crypto.signals
       WHERE created_at > now() - interval '24 hours'
       ORDER BY created_at DESC
       LIMIT 100`
    );
    return NextResponse.json(
      { signals: rows, timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('crypto/signals fetch error:', error);
    return NextResponse.json({ signals: [], error: 'Failed' }, { status: 500 });
  }
}
