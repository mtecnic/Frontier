import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pool } from './db.ts';

function migrationsDir(): string {
  // Bundled: dist/migrations next to dist/server.mjs. Source: server/migrations.
  const candidates = [new URL('./migrations/', import.meta.url), new URL('../server/migrations/', import.meta.url)];
  for (const u of candidates) {
    const p = fileURLToPath(u);
    if (existsSync(p)) return p;
  }
  throw new Error('migrations folder not found');
}

export async function migrate(log = true): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(424242)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
    const done = new Set(
      (await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version),
    );
    const dir = migrationsDir();
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(`${dir}/${f}`, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
        await client.query('COMMIT');
        if (log) console.log(`migrated ${f}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
    client.release();
  }
}
