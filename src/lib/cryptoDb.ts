import { Pool } from 'pg';

let pool: Pool | null = null;

export function getCryptoDb(): Pool {
  if (!pool) {
    const connectionString = process.env.CRYPTO_DATABASE_URL;
    if (!connectionString) {
      throw new Error('CRYPTO_DATABASE_URL is not set');
    }
    pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 30000 });
  }
  return pool;
}
