import pg from 'pg';
import { env } from './env.ts';

// BIGINT and COUNT come back as strings by default; every amount we store fits in a double.
pg.types.setTypeParser(20, (v) => Number(v));
// NUMERIC (e.g. SUM of BIGINT) as number.
pg.types.setTypeParser(1700, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: Number(process.env.DB_POOL_SIZE || 10),
});

pool.on('error', (err) => console.error('Postgres pool error:', err));

export type Db = pg.Pool | pg.PoolClient;

export async function q<T extends pg.QueryResultRow = any>(
  db: Db,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const r = await db.query<T>(text, params);
  return r.rows;
}

export async function q1<T extends pg.QueryResultRow = any>(
  db: Db,
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const r = await db.query<T>(text, params);
  return r.rows[0] ?? null;
}

const RETRYABLE = new Set(['40001', '40P01']);

/** Run fn in a transaction; retries on serialization failures and deadlocks. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      if (RETRYABLE.has(err?.code) && i < attempts) {
        await new Promise((r) => setTimeout(r, 20 * i + Math.random() * 30));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
