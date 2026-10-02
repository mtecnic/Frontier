import type pg from 'pg';
import { cellIdOf, parseParcelId } from '../shared/grid.ts';
import { currentPrice } from '../shared/pricing.ts';
import type { CheckinResult, ClaimedPrize } from '../shared/types.ts';
import { tx } from './db.ts';
import { credit, priceState, settleIncome, settleParcels } from './economy.ts';
import { parseFix, verifyFix } from './location.ts';
import { buildMe, buildSummary } from './me.ts';

/**
 * POST /checkin: verify the fix, settle income, record an owner visit, claim
 * any prize in the cell, and return the player's state. Also counts as an app
 * open for the salary window.
 */
export async function checkin(userId: number, rawFix: unknown, now: number): Promise<CheckinResult> {
  const fix = parseFix(rawFix);
  const cellId = fix && Number.isFinite(fix.lat) && Number.isFinite(fix.lng) ? cellIdOf(fix.lat, fix.lng) : null;

  return tx(async (c) => {
    const inc = await settleIncome(c, userId, now, { open: true, extraParcelId: cellId });
    let fixStatus: CheckinResult['fix'] = 'none';
    let fixMessage: string | undefined;
    let visited: CheckinResult['visited'] = null;
    let prizes: ClaimedPrize[] = [];
    let acceptedCell: string | null = null;

    if (fix) {
      const check = await verifyFix(c, inc.user, fix, now);
      fixStatus = check.status;
      fixMessage = check.message;
      if (check.status === 'accepted' && check.cellId) {
        acceptedCell = check.cellId;
        const p = inc.locked.get(check.cellId);
        if (p && p.owner_id === userId) {
          // Owner visit: bank rent at the old price first, then restore the price to max.
          await settleParcels(c, userId, [p], now, p.id);
          await c.query('UPDATE parcels SET last_visit_at = $2 WHERE id = $1', [p.id, new Date(now)]);
          p.last_visit_at = new Date(now);
          visited = { parcelId: p.id, price: currentPrice(priceState(p), now) };
        }
        prizes = await claimPrizes(c, userId, check.cellId, now);
      }
    }

    const me = await buildMe(c, userId, now);
    const summary = inc.newLogin ? await buildSummary(c, userId, inc.user.summary_from) : null;
    return {
      fix: fixStatus,
      fixMessage,
      cellId: acceptedCell,
      me,
      newLogin: inc.newLogin,
      summary,
      income: { salaryCents: inc.salaryCents, rentCents: inc.rentCents, businessCents: inc.businessCents },
      visited,
      prizes,
      serverTime: new Date(now).toISOString(),
    };
  });
}

/** First player with a verified fix inside the parcel takes every live prize there. */
async function claimPrizes(c: pg.PoolClient, userId: number, cellId: string, now: number): Promise<ClaimedPrize[]> {
  const cell = parseParcelId(cellId);
  if (!cell) return [];
  const r = await c.query<{ id: number; parcel_id: string; kind: 'cash' | 'lawyer'; amount_cents: number }>(
    `UPDATE prizes SET claimed_by = $1, claimed_at = $2
      WHERE gx = $3 AND gy = $4 AND claimed_by IS NULL AND expires_at > $2
      RETURNING id, parcel_id, kind, amount_cents`,
    [userId, new Date(now), cell.gx, cell.gy],
  );
  for (const p of r.rows) {
    if (p.kind === 'cash') await credit(c, userId, p.amount_cents, 'prize', now, { parcelId: p.parcel_id });
    else await c.query('UPDATE users SET lawyers = lawyers + 1 WHERE id = $1', [userId]);
  }
  return r.rows.map((p) => ({
    id: p.id,
    parcelId: p.parcel_id,
    kind: p.kind,
    amountCents: p.amount_cents,
    claimedAt: new Date(now).toISOString(),
  }));
}
