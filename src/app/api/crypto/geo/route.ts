import { NextResponse } from 'next/server';
import { getCryptoDb } from '@/lib/cryptoDb';

export interface GeoRow {
  kind: string;
  country: string;
  metric_value: number;
  collected_at: string;
}

export function formatGeoNode(row: GeoRow): GeoRow {
  return { ...row, metric_value: Math.round(row.metric_value * 100) / 100 };
}

export async function GET() {
  try {
    const db = getCryptoDb();
    const { rows } = await db.query<GeoRow>(
      `SELECT kind, country, metric_value, collected_at
       FROM crypto.geo_nodes
       WHERE collected_at > now() - interval '3 hours'
         AND collected_at > (SELECT max(collected_at) FROM crypto.geo_nodes) - interval '10 seconds'
       ORDER BY metric_value DESC`
    );
    return NextResponse.json(
      { geo: rows.map(formatGeoNode), timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('crypto/geo fetch error:', error);
    return NextResponse.json({ geo: [], error: 'Failed' }, { status: 500 });
  }
}
