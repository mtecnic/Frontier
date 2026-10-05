import type { Db } from './db.ts';

/**
 * Record a suspicious pattern for manual review. Flags never block play on
 * their own; an admin decides whether to freeze. Duplicate open flags of the
 * same kind inside `dedupeMs` are skipped.
 */
export async function raiseFlag(
  db: Db,
  userId: number,
  kind: string,
  detail: Record<string, unknown>,
  now: number,
  dedupeMs = 86_400_000,
): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO flags (user_id, kind, detail, created_at)
     SELECT $1, $2, $3, $4
      WHERE NOT EXISTS (
        SELECT 1 FROM flags WHERE user_id = $1 AND kind = $2 AND resolved_at IS NULL AND created_at > $5)`,
    [userId, kind, JSON.stringify(detail), new Date(now), new Date(now - dedupeMs)],
  );
  if (r.rowCount) console.warn(`flag raised: user ${userId} ${kind}`, detail);
  return !!r.rowCount;
}
