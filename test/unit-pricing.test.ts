import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUR_MS } from '../shared/config.ts';
import {
  currentPrice,
  nextMaxPrice,
  settleRent,
  settleSalary,
  spookTakeCents,
  sellerShareCents,
  parcelColor,
  itemPrice,
  hourlyLandRentCents,
} from '../shared/pricing.ts';
import { cellOf, parcelId, parseParcelId, cellBounds, haversineKm, isInCell } from '../shared/grid.ts';

const T0 = Date.UTC(2026, 0, 1);

test('price ladder from the spec: $5, $8, $12 ... passes $1,000 on the 14th sale', () => {
  const ladder = [5];
  for (let i = 0; i < 13; i++) ladder.push(nextMaxPrice(ladder[ladder.length - 1]!, false));
  assert.deepEqual(ladder.slice(0, 11), [5, 8, 12, 18, 27, 41, 62, 93, 140, 210, 315]);
  assert.ok(ladder[12]! < 1000 && ladder[13]! > 1000, `14th sale price ${ladder[13]}`);
});

test('spec case table: parcel bought at $27 (max $41)', () => {
  const p = { maxPrice: nextMaxPrice(27, false), lastVisitAt: T0, hasStore: false };
  assert.equal(p.maxPrice, 41);
  // Jumped the same day at full price
  assert.equal(currentPrice(p, T0 + 2 * HOUR_MS), 41);
  assert.equal(sellerShareCents(41), 3280);
  assert.equal(nextMaxPrice(41, false), 62);
  // Jumped after 7 days without a visit
  assert.equal(currentPrice(p, T0 + 168 * HOUR_MS), 21);
  assert.equal(sellerShareCents(21), 1680);
  assert.equal(nextMaxPrice(21, false), 32);
});

test('price decays linearly, floors at half and never below $5', () => {
  const p = { maxPrice: 100, lastVisitAt: T0, hasStore: false };
  assert.equal(currentPrice(p, T0), 100);
  assert.equal(currentPrice(p, T0 + 84 * HOUR_MS), 75);
  assert.equal(currentPrice(p, T0 + 1000 * HOUR_MS), 50);
  assert.equal(currentPrice({ maxPrice: 8, lastVisitAt: T0, hasStore: false }, T0 + 1000 * HOUR_MS), 5);
  assert.equal(currentPrice(null, T0), 5);
});

test('store parcels add the premium and never decay', () => {
  const p = { maxPrice: 41, lastVisitAt: T0, hasStore: true };
  assert.equal(currentPrice(p, T0 + 500 * HOUR_MS), 41 + 7500);
  // Jumping a store parcel multiplies only the land part.
  assert.equal(nextMaxPrice(7541, true), 62);
  // Land rent on a store parcel ignores the premium by default.
  assert.equal(hourlyLandRentCents(p, T0), 82);
});

test('cheap land pays for itself in about 31 hours', () => {
  const p = { maxPrice: nextMaxPrice(5, false), lastVisitAt: T0, hasStore: false };
  let cents = 0;
  let hours = 0;
  while (cents < 500) {
    cents += hourlyLandRentCents(p, T0 + hours * HOUR_MS);
    hours++;
  }
  assert.ok(hours >= 31 && hours <= 33, `payback took ${hours}h`);
});

test('rent: whole hours only, fraction carries, capped at 72h', () => {
  const p = { maxPrice: 100, lastVisitAt: T0, hasStore: false };
  const a = settleRent(p, T0, T0 + 90 * 60_000);
  assert.equal(a.hours, 1);
  assert.equal(a.landCents, 200);
  assert.equal(a.settledAt, T0 + HOUR_MS);
  const none = settleRent(p, T0, T0 + 59 * 60_000);
  assert.equal(none.hours, 0);
  const capped = settleRent(p, T0, T0 + 200 * HOUR_MS);
  assert.equal(capped.hours, 72);
  assert.equal(capped.settledAt, T0 + 200 * HOUR_MS);
  const store = settleRent({ ...p, hasStore: true }, T0, T0 + 3 * HOUR_MS);
  assert.equal(store.businessCents, 4500);
});

test('salary: 12 hours after each open, partial hours carry while the window is open', () => {
  let s = { lastOpenAt: T0, salarySettledAt: T0 };
  // check-in 5.5h later: 5 hours paid, half hour carries
  let r = settleSalary(s, T0 + 5.5 * HOUR_MS, true);
  assert.equal(r.hours, 5);
  assert.equal(r.salarySettledAt, T0 + 5 * HOUR_MS);
  s = r;
  // next open 20h after the first: window [5.5h, 17.5h] pays 12h more from 5h -> 17h; then restarts
  r = settleSalary(s, T0 + 25.5 * HOUR_MS, true);
  assert.equal(r.hours, 12);
  assert.equal(r.salarySettledAt, T0 + 25.5 * HOUR_MS);
  assert.equal(r.cents, 12 * 500);
  // opening twice a day, 12h apart, pays 24 hours a day
  let st = { lastOpenAt: T0, salarySettledAt: T0 };
  let total = 0;
  for (let day = 0; day < 3; day++) {
    for (const h of [12, 24]) {
      const out = settleSalary(st, T0 + (day * 24 + h) * HOUR_MS, true);
      total += out.hours;
      st = out;
    }
  }
  assert.equal(total, 72);
});

test('spook take: larger of $30 or half the price, capped at remaining cash', () => {
  assert.equal(spookTakeCents(41, 100_00), 3000);
  assert.equal(spookTakeCents(200, 1000_00), 10000);
  assert.equal(spookTakeCents(200, 1234), 1234);
  assert.equal(spookTakeCents(200, 0), 0);
});

test('colors and item prices', () => {
  assert.equal(parcelColor(null, 1, 5), 'unowned');
  assert.equal(parcelColor(1, 1, 5000), 'mine');
  assert.equal(parcelColor(2, 1, 49), 'yellow');
  assert.equal(parcelColor(2, 1, 50), 'orange');
  assert.equal(parcelColor(2, 1, 500), 'red');
  assert.equal(itemPrice('spook', 'store'), 40);
  assert.equal(itemPrice('spook', 'store', true), 20);
  assert.equal(itemPrice('flare', 'store', true), 10);
  assert.equal(itemPrice('flare', 'office'), 40);
  assert.equal(itemPrice('lawyer', 'store'), null);
});

test('grid ids', () => {
  const c = cellOf(36.1699, -115.1398);
  assert.deepEqual(c, { gy: 7233, gx: -23028 });
  assert.equal(parcelId(c.gy, c.gx), '7233:-23028');
  assert.deepEqual(parseParcelId('7233:-23028'), c);
  assert.equal(parseParcelId('abc'), null);
  assert.equal(parseParcelId('99999:0'), null);
  const b = cellBounds(c.gy, c.gx);
  assert.ok(isInCell((b.north + b.south) / 2, (b.east + b.west) / 2, c.gy, c.gx));
  // ~555 m north-south
  const ns = haversineKm(b.south, b.west, b.north, b.west);
  assert.ok(ns > 0.55 && ns < 0.56, `${ns}`);
});
