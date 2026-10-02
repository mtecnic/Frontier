import { CONFIG } from '../shared/config.ts';
import { pool, q1, tx } from './db.ts';
import { env } from './env.ts';
import { now, setClockOffset, clockOffset } from './clock.ts';
import { HttpError, RateLimiter, bad, notFound, num, optBool, type Ctx, Router } from './http.ts';
import { registerAuthRoutes } from './auth.ts';
import { registerAdminRoutes } from './admin.ts';
import { buildMe, buildSummary } from './me.ts';
import { checkin } from './checkin.ts';
import { buildStore, buyParcel, myParcels, parcelDetail, parcelsInBox, parseBbox, placeSpook } from './parcels.ts';
import { parseShopRequest, shopBuy } from './shop.ts';
import { getBoard } from './boards.ts';
import { claimedPrizes } from './prizes.ts';
import { prizesNear, promotionsNear } from './nearby.ts';
import { redeemQr } from './business.ts';
import { isPushEndpoint, notifyUser, removeSubscription, saveSubscription, vapidPublicKey } from './push.ts';
import { deleteAccount, ledgerPage, renameUser } from './account.ts';
import { mailConfigured } from './mail.ts';
import { runNightly } from './nightly.ts';
import { credit, type UserRow } from './economy.ts';

const checkinLimiter = new RateLimiter(8, 10_000);
const pushTestLimiter = new RateLimiter(1, 60_000);

async function viewerRow(ctx: Ctx): Promise<UserRow | null> {
  if (!ctx.user) return null;
  return q1<UserRow>(pool, 'SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [ctx.user.id]);
}

/** Idempotency key from the header (or body), scoped to the route so keys can't collide across actions. */
function idemKey(ctx: Ctx, scope = ''): string | null {
  const h = ctx.req.headers['idempotency-key'];
  const k = (Array.isArray(h) ? h[0] : h) ?? (typeof ctx.body?.idempotencyKey === 'string' ? ctx.body.idempotencyKey : null);
  return k ? `${ctx.method} ${ctx.path} ${scope} ${String(k).slice(0, 100)}`.slice(0, 200) : null;
}

/**
 * Actions that need you standing on a parcel accept a fresh fix in the body.
 * It is checked in first (its own transaction), then the action runs. If the
 * action fails for location reasons, the fix's own problem is reported.
 */
async function withFix<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  let fixMessage: string | undefined;
  if (ctx.body?.fix) {
    const r = await checkin(ctx.user!.id, ctx.body.fix, now());
    if (r.fix !== 'accepted') fixMessage = r.fixMessage;
  }
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError && err.code === 'not_here' && fixMessage) {
      err.message = `${err.message} ${fixMessage}`;
    }
    throw err;
  }
}

export function buildRouter(): Router {
  const r = new Router();

  r.get('/config', 'none', () => ({
    config: CONFIG,
    vapidPublicKey: vapidPublicKey(),
    features: { passkeys: true, push: !!vapidPublicKey(), email: mailConfigured(), devLogin: env.DEV_LOGIN, testMode: env.TEST_MODE },
    serverTime: new Date(now()).toISOString(),
  }));

  registerAuthRoutes(r);
  registerAdminRoutes(r);

  // ---- Player ----

  r.get('/me', 'user', async (ctx) => {
    const at = now();
    const u = await viewerRow(ctx);
    if (!u) throw new HttpError(401, 'no_user', 'Account not found.');
    return { me: await buildMe(pool, u.id, at), summary: await buildSummary(pool, u.id, u.summary_from) };
  });

  r.patch('/me', 'user', async (ctx) => {
    if (ctx.body?.username !== undefined) await renameUser(ctx.user!.id, ctx.body.username);
    return { me: await buildMe(pool, ctx.user!.id, now()) };
  });

  r.delete('/me', 'user', async (ctx) => {
    const out = await deleteAccount(ctx.user!.id, String(ctx.body?.confirm ?? ''), now());
    ctx.setCookie('frontier_session', '', { maxAgeS: 0 });
    return out;
  });

  r.get('/me/parcels', 'user', (ctx) => myParcels(ctx.user!.id, now()));

  r.get('/me/ledger', 'user', async (ctx) => {
    const before = ctx.query.get('before');
    const b = before ? Number(before) : null;
    if (b != null && !(Number.isSafeInteger(b) && b > 0)) throw bad('invalid_before', 'before must be a ledger row id');
    const rows = await ledgerPage(ctx.user!.id, b);
    return rows.map((x) => ({ ...x, time: x.time.toISOString() }));
  });

  r.post('/checkin', 'user', async (ctx) => {
    if (!env.TEST_MODE && !checkinLimiter.take(String(ctx.user!.id)))
      throw new HttpError(429, 'throttled', 'Checking in too often.');
    return checkin(ctx.user!.id, ctx.body?.fix ?? null, now());
  });

  // ---- Parcels ----

  r.get('/parcels', 'optional', async (ctx) => {
    const b = parseBbox(ctx.query.get('bbox'));
    return parcelsInBox(b, await viewerRow(ctx), now());
  });

  r.get('/parcels/:id', 'optional', async (ctx) => parcelDetail(pool, ctx.params.id!, await viewerRow(ctx), now()));

  r.post('/parcels/:id/buy', 'user', (ctx) =>
    withFix(ctx, () =>
      buyParcel(
        ctx.user!.id,
        ctx.params.id!,
        {
          useFlare: optBool(ctx.body?.useFlare),
          useLawyer: optBool(ctx.body?.useLawyer),
          maxPrice: ctx.body?.maxPrice == null ? null : num(ctx.body.maxPrice, 'maxPrice', 0),
          idempotencyKey: idemKey(ctx),
        },
        now(),
      ),
    ),
  );

  r.post('/parcels/:id/spook', 'user', (ctx) => withFix(ctx, () => placeSpook(ctx.user!.id, ctx.params.id!, now(), idemKey(ctx))));
  r.post('/parcels/:id/store', 'user', (ctx) => withFix(ctx, () => buildStore(ctx.user!.id, ctx.params.id!, now(), idemKey(ctx))));

  r.post('/shop/buy', 'user', (ctx) => {
    const b = ctx.body ?? {};
    const req = parseShopRequest(b, idemKey(ctx, `${b.item}x${b.qty ?? 1}@${b.place ?? 'office'}:${b.parcelId ?? ''}`));
    const run = () => shopBuy(ctx.user!.id, req, now());
    return req.place === 'store' ? withFix(ctx, run) : run();
  });

  // ---- Prizes, promotions, QR ----

  r.get('/prizes', 'user', async (ctx) => {
    const u = await viewerRow(ctx);
    const at = now();
    const nearby = u?.last_fix_lat != null && u.last_fix_lng != null ? await prizesNear(pool, u.last_fix_lat, u.last_fix_lng, at) : [];
    return { nearby, claimed: await claimedPrizes(pool, ctx.user!.id), hasFix: u?.last_fix_lat != null };
  });

  r.get('/promotions', 'optional', async (ctx) => {
    const u = await viewerRow(ctx);
    let lat = u?.last_fix_lat ?? null;
    let lng = u?.last_fix_lng ?? null;
    if (ctx.query.get('lat') && ctx.query.get('lng')) {
      lat = num(ctx.query.get('lat'), 'lat', -90, 90);
      lng = num(ctx.query.get('lng'), 'lng', -180, 180);
    }
    if (lat == null || lng == null) return { nearby: [], hasLocation: false };
    return { nearby: await promotionsNear(pool, lat, lng, now()), hasLocation: true };
  });

  r.post('/qr/redeem', 'user', (ctx) => {
    const token = String(ctx.body?.token ?? '').trim();
    if (!token || token.length > 64) throw bad('invalid_token', 'That code is not valid.');
    return withFix(ctx, () => redeemQr(ctx.user!.id, token, now()));
  });

  // ---- Leaderboards ----

  r.get('/leaderboards/:board', 'optional', async (ctx) => {
    const u = await viewerRow(ctx);
    let where: { lat: number; lng: number } | null = null;
    if (ctx.query.get('lat') && ctx.query.get('lng'))
      where = { lat: num(ctx.query.get('lat'), 'lat', -90, 90), lng: num(ctx.query.get('lng'), 'lng', -180, 180) };
    else if (u?.last_fix_lat != null && u.last_fix_lng != null) where = { lat: u.last_fix_lat, lng: u.last_fix_lng };
    return getBoard(pool, ctx.params.board!, ctx.query.get('scope') ?? 'global', u?.id ?? null, where);
  });

  // ---- Push ----

  r.post('/push/subscribe', 'user', async (ctx) => {
    const s = ctx.body?.subscription;
    if (
      typeof s?.endpoint !== 'string' ||
      s.endpoint.length > 1000 ||
      !isPushEndpoint(s.endpoint) ||
      typeof s?.keys?.p256dh !== 'string' ||
      typeof s?.keys?.auth !== 'string' ||
      s.keys.p256dh.length > 200 ||
      s.keys.auth.length > 100
    )
      throw bad('invalid_subscription', 'That push subscription is not from a supported browser push service.');
    await saveSubscription(ctx.user!.id, s);
    return { ok: true };
  });

  r.post('/push/unsubscribe', 'user', async (ctx) => {
    await removeSubscription(ctx.user!.id, String(ctx.body?.endpoint ?? ''));
    return { ok: true };
  });

  r.post('/push/test', 'user', async (ctx) => {
    if (!pushTestLimiter.take(String(ctx.user!.id))) throw new HttpError(429, 'rate_limited', 'One test alert a minute, please.');
    const sent = await notifyUser(ctx.user!.id, {
      title: `${CONFIG.GAME_NAME} alerts are on`,
      body: "You'll hear from us when someone jumps your claim.",
      url: '#/me',
      tag: 'test',
    });
    return { sent };
  });

  // ---- Test hooks (TEST_MODE only) ----

  if (env.TEST_MODE) {
    r.post('/test/clock', 'none', (ctx) => {
      if (ctx.body?.advanceMs != null) setClockOffset(clockOffset() + num(ctx.body.advanceMs, 'advanceMs'));
      else setClockOffset(num(ctx.body?.offsetMs ?? 0, 'offsetMs'));
      return { offsetMs: clockOffset(), serverTime: new Date(now()).toISOString() };
    });
    r.post('/test/nightly', 'none', async () => (await runNightly({ force: true })) ?? { skipped: true });
    r.post('/test/grant', 'none', async (ctx) => {
      const userId = num(ctx.body?.userId, 'userId', 1);
      const cents = num(ctx.body?.cents, 'cents', 1, 1e9);
      await tx((c) => credit(c, userId, Math.round(cents), 'admin', now(), { note: 'test grant' }));
      return { me: await buildMe(pool, userId, now()) };
    });
    r.post('/test/prize', 'none', async (ctx) => {
      const id = String(ctx.body?.parcelId ?? '');
      const [gy, gx] = id.split(':').map(Number);
      if (!Number.isInteger(gy) || !Number.isInteger(gx)) throw notFound();
      const at = now();
      return q1(
        pool,
        `INSERT INTO prizes (parcel_id, gy, gx, kind, amount_cents, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [id, gy, gx, ctx.body?.kind === 'lawyer' ? 'lawyer' : 'cash', Number(ctx.body?.amountCents ?? 1500), new Date(at), new Date(at + 48 * 3_600_000)],
      );
    });
  }

  return r;
}
