import { pool, q, tx } from './db.ts';
import { lockUser, type ParcelRow } from './economy.ts';
import { HttpError, bad } from './http.ts';
import { validateUsername } from './auth.ts';

/**
 * Delete an account: its parcels return to unowned (rows removed, with a
 * 'release' deed for history), its stores and Spooks go with them, and personal
 * data is scrubbed. Ledger rows stay so the books still balance.
 */
export async function deleteAccount(userId: number, confirm: string, at: number) {
  return tx(async (c) => {
    const parcels = (
      await c.query<ParcelRow>('SELECT * FROM parcels WHERE owner_id = $1 ORDER BY id FOR UPDATE', [userId])
    ).rows;
    const user = await lockUser(c, userId);
    if (confirm.trim().toLowerCase() !== user.username.toLowerCase())
      throw bad('confirm', 'Type your username to confirm.');
    for (const p of parcels) {
      await c.query(
        `INSERT INTO deeds (parcel_id, time, from_user, to_user, price_cents, kind, had_store) VALUES ($1, $2, $3, NULL, 0, 'release', $4)`,
        [p.id, new Date(at), userId, p.has_store],
      );
    }
    await c.query('DELETE FROM parcels WHERE owner_id = $1', [userId]);
    await c.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    await c.query('DELETE FROM passkeys WHERE user_id = $1', [userId]);
    await c.query('DELETE FROM push_subscriptions WHERE user_id = $1', [userId]);
    await c.query('DELETE FROM idempotency WHERE user_id = $1', [userId]);
    await c.query(
      `UPDATE users SET deleted_at = $2, email = NULL, username = 'deleted-' || id, last_fix_lat = NULL,
              last_fix_lng = NULL, last_fix_at = NULL, signup_ip = NULL WHERE id = $1`,
      [userId, new Date(at)],
    );
    await c.query('UPDATE fix_log SET lat = NULL, lng = NULL WHERE user_id = $1', [userId]);
    return { ok: true, parcelsReleased: parcels.length };
  });
}

export async function renameUser(userId: number, raw: unknown) {
  const username = validateUsername(raw);
  try {
    const r = await pool.query('UPDATE users SET username = $2 WHERE id = $1 AND deleted_at IS NULL', [userId, username]);
    if (!r.rowCount) throw new HttpError(401, 'no_user', 'Account not found.');
  } catch (err: any) {
    if (err?.code === '23505') throw new HttpError(409, 'username_taken', 'That username is taken.');
    throw err;
  }
  return username;
}

export async function ledgerPage(userId: number, before: number | null, limit = 50) {
  return q<{ id: number; time: Date; type: string; amount_cents: number; parcel_id: string | null; other: string | null; note: string | null }>(
    pool,
    `SELECT l.id, l.time, l.type, l.amount_cents, l.parcel_id, o.username AS other, l.note
       FROM ledger l LEFT JOIN users o ON o.id = l.other_user_id
      WHERE l.user_id = $1 AND ($2::bigint IS NULL OR l.id < $2)
      ORDER BY l.id DESC LIMIT $3`,
    [userId, before, limit],
  );
}
