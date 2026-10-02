/**
 * End-to-end API tests against a real PostgreSQL database (TEST_DATABASE_URL,
 * default postgres://frontier:frontier@localhost:5432/frontier_test).
 * The test database is wiped at the start.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { Client, fixIn, startTestServer } from './helpers.ts';
import { settleRent } from '../shared/pricing.ts';
import { HOUR_MS } from '../shared/config.ts';

const GY = 7233; // Las Vegas
const GX = -23028;
const id = (dy: number, dx: number) => `${GY + dy}:${GX + dx}`;

let base = '';
let server: Server;
let anon: Client;
let alice: Client;
let bob: Client;
let admin: Client;

async function advance(ms: number) {
  await anon.ok('POST', '/test/clock', { advanceMs: ms });
}

/** Walk to a cell (two minutes pass first so the speed check is happy) and check in. */
async function moveTo(c: Client, dy: number, dx: number) {
  await advance(2 * 60_000);
  const r = await c.ok('POST', '/checkin', { fix: fixIn(GY + dy, GX + dx) });
  assert.equal(r.fix, 'accepted', `${c.username} fix at ${id(dy, dx)}: ${r.fixMessage}`);
  return r;
}

async function buy(c: Client, dy: number, dx: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return c.call('POST', `/parcels/${id(dy, dx)}/buy`, { fix: fixIn(GY + dy, GX + dx), ...extra }, headers);
}

async function me(c: Client) {
  return (await c.ok('GET', '/me')).me;
}

async function grant(c: Client, cents: number) {
  await anon.ok('POST', '/test/grant', { userId: c.userId, cents });
}

before(async () => {
  ({ base, server } = await startTestServer());
  anon = new Client(base);
  alice = new Client(base);
  bob = new Client(base);
  admin = new Client(base);
});

after(async () => {
  server.close();
  const { pool } = await import('../server/db.ts');
  await pool.end();
});

test('sign up: starting cash and starter kit; usernames are unique', async () => {
  const a = await alice.signUp('alice@example.com', 'alice');
  assert.equal(a.cashCents, 20000);
  assert.deepEqual(a.inventory, { lawyers: 0, permits: 0, spooks: 1, flares: 2 });
  await bob.signUp('bob@example.com', 'bob');
  const ad = await admin.signUp('admin@example.com', 'sheriff');
  assert.equal(ad.isAdmin, true);

  const dupe = new Client(base);
  const link = await dupe.ok('POST', '/auth/link', { email: 'carol@example.com' });
  const v = await dupe.ok('POST', '/auth/verify', { requestId: link.requestId, code: link.devCode });
  const taken = await dupe.call('POST', '/auth/signup', { signupToken: v.signupToken, username: 'ALICE' });
  assert.equal(taken.status, 409);
  const badName = await dupe.call('POST', '/auth/signup', { signupToken: v.signupToken, username: 'a b' });
  assert.equal(badName.status, 400);

  // Wrong code is refused; the magic-link token also works for an existing account.
  const l2 = await anon.ok('POST', '/auth/link', { email: 'alice@example.com' });
  const wrong = await anon.call('POST', '/auth/verify', { requestId: l2.requestId, code: '000000' === l2.devCode ? '111111' : '000000' });
  assert.equal(wrong.status, 400);
  const viaLink = new Client(base);
  const ok = await viaLink.ok('POST', '/auth/verify', { token: l2.devToken });
  assert.equal(ok.me.username, 'alice');
  assert.ok(viaLink.cookie, 'session cookie set');
});

test('map is browsable without an account; buying needs one', async () => {
  const r = await anon.ok('GET', `/parcels?bbox=-115.2,36.1,-115.1,36.2`);
  assert.deepEqual(r.parcels, []);
  const d = await anon.ok('GET', `/parcels/${id(0, 0)}`);
  assert.equal(d.ownerId, null);
  assert.equal(d.price, 5);
  const b = await anon.call('POST', `/parcels/${id(0, 0)}/buy`, {});
  assert.equal(b.status, 401);
});

test('location trust: accuracy, freshness and speed', async () => {
  let r = await alice.ok('POST', '/checkin', { fix: fixIn(GY, GX, 150) });
  assert.equal(r.fix, 'inaccurate');
  r = await alice.ok('POST', '/checkin', { fix: fixIn(GY, GX, 10, 45_000) });
  assert.equal(r.fix, 'stale');
  r = await alice.ok('POST', '/checkin', { fix: fixIn(GY, GX) });
  assert.equal(r.fix, 'accepted');
  assert.equal(r.cellId, id(0, 0));
  // 50 km away a moment later
  r = await alice.ok('POST', '/checkin', { fix: fixIn(GY + 90, GX) });
  assert.equal(r.fix, 'too_fast');
  // A flight is fine after an hour
  await advance(2 * HOUR_MS);
  r = await alice.ok('POST', '/checkin', { fix: fixIn(GY + 90, GX) });
  assert.equal(r.fix, 'accepted');
  await advance(2 * HOUR_MS);
  await moveTo(alice, 0, 0);
});

test('buying unowned land, the lock, and claim jumping', async () => {
  const cash0 = (await me(alice)).cashCents;
  const r = await buy(alice, 0, 0, { maxPrice: 5 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.paid, 5);
  assert.equal(r.data.parcel.maxPrice, 8);
  assert.equal(r.data.parcel.price, 8);
  assert.equal(r.data.parcel.locked, true);
  assert.equal(r.data.me.cashCents, cash0 - 500);

  // Bob is not there
  let b = await bob.call('POST', `/parcels/${id(0, 0)}/buy`, {});
  assert.equal(b.status, 403);
  assert.equal(b.data.error, 'not_here');
  // Bob walks there: locked for 24 hours
  await moveTo(bob, 0, 0);
  b = await buy(bob, 0, 0);
  assert.equal(b.status, 409);
  assert.equal(b.data.error, 'locked');
  // Own parcel
  const own = await buy(alice, 0, 0);
  assert.equal(own.data.error, 'own_parcel');

  await advance(24 * HOUR_MS + 60_000);
  const detail = await bob.ok('GET', `/parcels/${id(0, 0)}`);
  assert.equal(detail.owner, 'alice');
  const before = await me(alice);
  b = await buy(bob, 0, 0, { maxPrice: detail.price });
  assert.equal(b.status, 200, JSON.stringify(b.data));
  assert.equal(b.data.paid, detail.price);
  assert.equal(b.data.seller, 'alice');
  assert.equal(b.data.sellerReceivedCents, detail.price * 80);
  const after = await me(alice);
  // Alice got 80% plus the rent banked on that parcel up to the sale.
  assert.ok(after.cashCents >= before.cashCents + detail.price * 80, `${after.cashCents} vs ${before.cashCents}`);
  assert.equal(after.parcelsOwned, 0);

  // price_changed guard
  await advance(24 * HOUR_MS + 60_000);
  await moveTo(alice, 0, 0);
  const pc = await buy(alice, 0, 0, { maxPrice: 1 });
  assert.equal(pc.status, 409);
  assert.equal(pc.data.error, 'price_changed');
});

test('two accounts jump each other back and forth; every balance matches its ledger', async () => {
  let current = alice;
  let other = bob;
  for (let i = 0; i < 4; i++) {
    await moveTo(current, 0, 0);
    const r = await buy(current, 0, 0);
    assert.equal(r.status, 200, `${current.username} round ${i}: ${JSON.stringify(r.data)}`);
    await advance(24 * HOUR_MS + 60_000);
    [current, other] = [other, current];
  }
  const audit = await admin.ok('POST', '/admin/audit');
  assert.equal(audit.mismatches.length, 0, JSON.stringify(audit.mismatches));
  assert.ok(audit.checked >= 3);
});

test('Spook steals from a jumper; a Flare destroys it', async () => {
  // Alice buys Y and spooks it.
  await moveTo(alice, 0, 1);
  let r = await buy(alice, 0, 1);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const sp = await alice.ok('POST', `/parcels/${id(0, 1)}/spook`, { fix: fixIn(GY, GX + 1) });
  assert.equal(sp.parcel.spook, true);
  assert.equal(sp.me.inventory.spooks, 0);
  const again = await alice.call('POST', `/parcels/${id(0, 1)}/spook`, { fix: fixIn(GY, GX + 1) });
  assert.equal(again.status, 409);

  await advance(24 * HOUR_MS + 60_000);
  await moveTo(bob, 0, 1);
  const aliceBefore = await me(alice);
  r = await buy(bob, 0, 1);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.spook.outcome, 'triggered');
  assert.equal(r.data.spook.takenCents, 3000);
  assert.equal(r.data.parcel.spook, false);
  const aliceAfter = await me(alice);
  assert.ok(aliceAfter.cashCents >= aliceBefore.cashCents + 3000 + r.data.sellerReceivedCents);

  // Alice buys a Spook at the Land Office, buys Z and spooks it; Bob uses a Flare.
  const shop = await alice.ok('POST', '/shop/buy', { item: 'spook', place: 'office' });
  assert.equal(shop.paidCents, 8000);
  await moveTo(alice, 0, 2);
  r = await buy(alice, 0, 2);
  assert.equal(r.status, 200);
  await alice.ok('POST', `/parcels/${id(0, 2)}/spook`, { fix: fixIn(GY, GX + 2) });
  await advance(24 * HOUR_MS + 60_000);
  await moveTo(bob, 0, 2);
  const flaresBefore = (await me(bob)).inventory.flares;
  r = await buy(bob, 0, 2, { useFlare: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.spook.outcome, 'flared');
  assert.equal(r.data.me.inventory.flares, flaresBefore - 1);
  const sum = (await alice.ok('GET', '/me')).summary;
  assert.ok(sum.spooksLost >= 1);
  assert.ok(sum.stolenCents >= 3000);
  assert.ok(sum.parcelsLost >= 2);
});

test('Lawyers buy remotely within 40 km, and cannot use a Flare', async () => {
  await grant(bob, 300000);
  const l = await bob.ok('POST', '/shop/buy', { item: 'lawyer', place: 'office', qty: 2 });
  assert.equal(l.me.inventory.lawyers, 2);
  await advance(5000);
  // ~10 km north, never visited
  let r = await bob.call('POST', `/parcels/${id(18, 0)}/buy`, { useLawyer: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.viaLawyer, true);
  assert.equal(r.data.me.inventory.lawyers, 1);
  // ~55 km away: out of range
  r = await bob.call('POST', `/parcels/${id(100, 0)}/buy`, { useLawyer: true });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'out_of_range');
  // Lawyer on a spooked parcel: the Spook triggers even if a Flare is asked for.
  await alice.ok('POST', '/shop/buy', { item: 'spook', place: 'office' });
  await moveTo(alice, 1, 0);
  assert.equal((await buy(alice, 1, 0)).status, 200);
  await alice.ok('POST', `/parcels/${id(1, 0)}/spook`, { fix: fixIn(GY + 1, GX) });
  await advance(24 * HOUR_MS + 60_000);
  await moveTo(bob, 5, 5); // somewhere else
  await advance(3500);
  const flares = (await me(bob)).inventory.flares;
  r = await bob.call('POST', `/parcels/${id(1, 0)}/buy`, { useLawyer: true, useFlare: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.spook.outcome, 'triggered');
  assert.equal(r.data.me.inventory.flares, flares);
  assert.equal(r.data.me.inventory.lawyers, 0);
});

test('idempotency keys never charge twice; two buyers cannot both win', async () => {
  await moveTo(bob, 2, 0);
  await advance(5000);
  const key = 'test-key-123';
  const [a, b] = await Promise.all([buy(bob, 2, 0, {}, { 'Idempotency-Key': key }), buy(bob, 2, 0, {}, { 'Idempotency-Key': key })]);
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(b.status, 200, JSON.stringify(b.data));
  assert.deepEqual(a.data.parcel.id, b.data.parcel.id);
  const ledger = await bob.ok('GET', '/me/ledger');
  const charges = ledger.filter((x: any) => x.type === 'purchase' && x.parcel_id === id(2, 0));
  assert.equal(charges.length, 1);
  // Retrying later with the same key replays the same answer.
  const c = await buy(bob, 2, 0, {}, { 'Idempotency-Key': key });
  assert.equal(c.status, 200);
  assert.equal(c.data.paid, a.data.paid);

  // Race: both stand on the same unowned parcel and buy at once.
  await moveTo(alice, 3, 0);
  await moveTo(bob, 3, 0);
  await advance(5000);
  const [ra, rb] = await Promise.all([buy(alice, 3, 0), buy(bob, 3, 0)]);
  const codes = [ra.status, rb.status].sort();
  assert.deepEqual(codes, [200, 409], `${JSON.stringify(ra.data)} ${JSON.stringify(rb.data)}`);

  // One purchase every 3 seconds
  await moveTo(bob, 3, 1);
  await advance(5000);
  assert.equal((await buy(bob, 3, 1)).status, 200);
  await advance(500);
  const fast = await buy(bob, 3, 1);
  assert.ok(fast.status === 429 || fast.data.error === 'own_parcel');
});

test('rent and salary settle lazily on check-in', async () => {
  const carol = new Client(base);
  await carol.signUp('carol@example.com', 'carol');
  await moveTo(carol, 4, 0);
  const t0r = await buy(carol, 4, 0);
  assert.equal(t0r.status, 200);
  const purchasedAt = Date.parse(t0r.data.parcel.purchasedAt);
  await moveTo(carol, 4, 1); // step off the parcel (2 min)
  await advance(10 * HOUR_MS);
  let r = await carol.ok('POST', '/checkin', { fix: fixIn(GY + 4, GX + 1) });
  assert.equal(r.income.rentCents, 160, '10 hours at $8 x 2%');
  assert.ok(r.newLogin, 'a 10-hour gap is a new login');
  assert.ok(r.summary.rentCents >= 160);
  assert.ok(r.income.salaryCents >= 5 * 500, `salary ${r.income.salaryCents}`);

  await advance(100 * HOUR_MS);
  r = await carol.ok('POST', '/checkin', { fix: fixIn(GY + 4, GX + 1) });
  const expected = settleRent({ maxPrice: 8, lastVisitAt: purchasedAt, hasStore: false }, purchasedAt + 10 * HOUR_MS, purchasedAt + 110 * HOUR_MS);
  assert.equal(expected.hours, 72);
  assert.equal(r.income.rentCents, expected.landCents, 'rent banks at most 72 hours');
  // The 12-hour salary window closed long ago: at most 12 hours paid.
  assert.ok(r.income.salaryCents <= 12 * 500);

  // Owner visit restores the price to max
  const d1 = await carol.ok('GET', `/parcels/${id(4, 0)}`);
  assert.ok(d1.price < 8);
  r = await moveTo(carol, 4, 0);
  assert.equal(r.visited.parcelId, id(4, 0));
  assert.equal(r.visited.price, 8);

  // Deleting the account releases the land
  const del = await carol.ok('DELETE', '/me', { confirm: 'carol' });
  assert.equal(del.parcelsReleased, 1);
  const d2 = await anon.ok('GET', `/parcels/${id(4, 0)}`);
  assert.equal(d2.ownerId, null);
  assert.equal((await carol.call('GET', '/me')).status, 401);
});

test('stores: permit, business rent, sales split, owner discount', async () => {
  await grant(alice, 1_000_000);
  const p = await alice.ok('POST', '/shop/buy', { item: 'permit', place: 'office' });
  assert.equal(p.me.inventory.permits, 1);
  await moveTo(alice, 5, 0);
  assert.equal((await buy(alice, 5, 0)).status, 200);
  const st = await alice.ok('POST', `/parcels/${id(5, 0)}/store`, { fix: fixIn(GY + 5, GX) });
  assert.equal(st.parcel.store, true);
  assert.equal(st.parcel.maxPrice, 8 + 7500);
  assert.equal(st.parcel.price, 8 + 7500);
  assert.equal(st.me.inventory.permits, 0);

  await moveTo(bob, 5, 0);
  const aliceBefore = await me(alice);
  const sale = await bob.ok('POST', '/shop/buy', { item: 'spook', place: 'store', parcelId: id(5, 0), fix: fixIn(GY + 5, GX) });
  assert.equal(sale.paidCents, 4000);
  assert.equal(sale.ownerCents, 2000);
  const notSold = await bob.call('POST', '/shop/buy', { item: 'lawyer', place: 'store', parcelId: id(5, 0) });
  assert.equal(notSold.status, 400);
  const own = await alice.ok('POST', '/shop/buy', { item: 'flare', place: 'store', parcelId: id(5, 0), fix: fixIn(GY + 5, GX) });
  assert.equal(own.paidCents, 1000);
  const aliceAfter = await me(alice);
  assert.equal(aliceAfter.cashCents, aliceBefore.cashCents + 2000 - 1000);

  const limit = await bob.call('POST', '/shop/buy', { item: 'flare', place: 'office', qty: 10 });
  assert.equal(limit.status, 409);
  assert.equal(limit.data.error, 'carry_limit');

  await advance(3 * HOUR_MS);
  const r = await alice.ok('POST', '/checkin', {});
  assert.ok(r.income.businessCents >= 3 * 1500, `business ${r.income.businessCents}`);

  // The store does not decay and goes with the parcel when jumped.
  await advance(24 * HOUR_MS);
  const d = await anon.ok('GET', `/parcels/${id(5, 0)}`);
  assert.equal(d.price, 7508);
  await grant(bob, 1_000_000);
  await moveTo(bob, 5, 0);
  const j = await buy(bob, 5, 0);
  assert.equal(j.status, 200, JSON.stringify(j.data));
  assert.equal(j.data.paid, 7508);
  assert.equal(j.data.sellerReceivedCents, 600640);
  assert.equal(j.data.parcel.store, true);
  assert.equal(j.data.parcel.maxPrice, 12 + 7500);
});

test('prizes: first verified fix in the parcel takes it; nightly spawn', async () => {
  await anon.ok('POST', '/test/prize', { parcelId: id(6, 0), amountCents: 2300 });
  const nearby = await bob.ok('GET', '/prizes');
  assert.ok(nearby.nearby.some((p: any) => p.parcelId === id(6, 0)));
  const r = await moveTo(bob, 6, 0);
  assert.equal(r.prizes.length, 1);
  assert.equal(r.prizes[0].amountCents, 2300);
  const a = await moveTo(alice, 6, 0);
  assert.equal(a.prizes.length, 0);
  await advance(5000);
  assert.equal((await buy(alice, 6, 0)).status, 200);

  const n = await anon.ok('POST', '/test/nightly');
  assert.ok(n.prizes >= 4, `spawned ${n.prizes}`);
  assert.equal(n.ledgerAudit.mismatches, 0);
});

test('six leaderboards, global and local', async () => {
  for (const board of ['money', 'parcels', 'expensive', 'land_value', 'shop_keep', 'spectral_thief']) {
    const g = await alice.ok('GET', `/leaderboards/${board}?scope=global`);
    assert.ok(g.date, board);
    for (let i = 1; i < g.rows.length; i++) assert.ok(g.rows[i - 1].value >= g.rows[i].value);
  }
  const shop = await alice.ok('GET', '/leaderboards/shop_keep?scope=global');
  assert.equal(shop.rows[0].username, 'alice');
  assert.ok(shop.me && shop.me.value >= 2000 + 3 * 1500);
  const thief = await alice.ok('GET', '/leaderboards/spectral_thief');
  assert.equal(thief.rows[0].username, 'alice');
  const local = await anon.ok('GET', `/leaderboards/parcels?scope=local&lat=36.17&lng=-115.14`);
  assert.ok(local.rows.length >= 2);
  const far = await anon.ok('GET', `/leaderboards/parcels?scope=local&lat=40.7&lng=-74.0`);
  assert.equal(far.rows.length, 0);
});

test('promotions and QR refill stations', async () => {
  const promo = await admin.ok('POST', '/admin/promotions', {
    parcelId: id(7, 0),
    business: 'Sagebrush Coffee',
    title: 'Free refill with any pastry',
  });
  await admin.ok('POST', '/admin/promotions', { lat: 40.7, lng: -74.0, business: 'Far Away', title: 'Too far' });
  const list = await bob.ok('GET', '/promotions');
  assert.ok(list.nearby.some((p: any) => p.id === promo.id));
  assert.ok(!list.nearby.some((p: any) => p.business === 'Far Away'));
  const forbidden = await bob.call('GET', '/admin/flags');
  assert.equal(forbidden.status, 403);

  const st = await admin.ok('POST', '/admin/qr', { parcelId: id(8, 0), name: 'Sagebrush Coffee counter' });
  let r = await bob.call('POST', '/qr/redeem', { token: st.token });
  assert.equal(r.status, 403);
  await moveTo(bob, 8, 0);
  const flares = (await me(bob)).inventory.flares;
  r = await bob.call('POST', '/qr/redeem', { token: st.token, fix: fixIn(GY + 8, GX) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.me.inventory.flares, flares + 1);
  r = await bob.call('POST', '/qr/redeem', { token: st.token, fix: fixIn(GY + 8, GX) });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'cooldown');
});

test('a frozen account cannot jump other players until cleared', async () => {
  await admin.ok('POST', `/admin/users/${bob.userId}/freeze`, { frozen: true });
  await advance(25 * HOUR_MS);
  await moveTo(alice, 9, 0);
  assert.equal((await buy(alice, 9, 0)).status, 200);
  await advance(25 * HOUR_MS);
  await moveTo(bob, 9, 0);
  let r = await buy(bob, 9, 0);
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'under_review');
  await moveTo(bob, 9, 1);
  await advance(4000);
  r = await buy(bob, 9, 1);
  assert.equal(r.status, 200, 'unowned land is still fine');
  await admin.ok('POST', `/admin/users/${bob.userId}/freeze`, { frozen: false, resolveFlags: true });
  await moveTo(bob, 9, 0);
  r = await buy(bob, 9, 0);
  assert.equal(r.status, 200, JSON.stringify(r.data));
});

test('final ledger audit: cash equals the ledger for everyone', async () => {
  const audit = await admin.ok('POST', '/admin/audit');
  assert.equal(audit.mismatches.length, 0, JSON.stringify(audit.mismatches));
  const stats = await admin.ok('GET', '/admin/stats');
  assert.ok(stats.stats.parcels > 5);
});
