import { CONFIG, HOUR_MS } from './config.ts';

/** Round a dollar amount to whole dollars, halves up (20.5 -> 21). */
export function roundDollars(x: number): number {
  return Math.floor(x + 0.5 + 1e-9);
}

/** The price-relevant fields of an owned parcel. Prices are whole dollars. */
export interface PriceState {
  /** Land max price in dollars, excluding any store premium. */
  maxPrice: number;
  /** Last purchase or owner visit, epoch ms. */
  lastVisitAt: number;
  hasStore: boolean;
}

/** Land component of the current price: decays from max to half over DECAY_HOURS, never below MIN_PRICE. */
export function landPrice(p: PriceState, at: number): number {
  if (p.hasStore) return Math.max(CONFIG.MIN_PRICE, p.maxPrice);
  const h = Math.max(0, (at - p.lastVisitAt) / HOUR_MS);
  const factor = 1 - (1 - CONFIG.DECAY_FLOOR_FRACTION) * Math.min(1, h / CONFIG.DECAY_HOURS);
  return Math.max(CONFIG.MIN_PRICE, roundDollars(p.maxPrice * factor));
}

/** What a buyer pays right now, in whole dollars. Unowned land (null) costs UNOWNED_PRICE. */
export function currentPrice(p: PriceState | null, at: number): number {
  if (!p) return CONFIG.UNOWNED_PRICE;
  return landPrice(p, at) + (p.hasStore ? CONFIG.STORE_PRICE_PREMIUM : 0);
}

/** Max price including the store premium (what the boards and Parcel Info show). */
export function effectiveMaxPrice(p: PriceState): number {
  return p.maxPrice + (p.hasStore ? CONFIG.STORE_PRICE_PREMIUM : 0);
}

/**
 * Land max price after a purchase at `paid` dollars. For a store parcel the
 * premium is part of what was paid but is not multiplied: it stays a flat add-on.
 */
export function nextMaxPrice(paid: number, hasStore: boolean): number {
  const land = hasStore ? Math.max(0, paid - CONFIG.STORE_PRICE_PREMIUM) : paid;
  return Math.max(CONFIG.MIN_MAX_PRICE, roundDollars(land * CONFIG.MAX_PRICE_MULTIPLIER));
}

/** Land rent for one hour starting at `at`, in cents. */
export function hourlyLandRentCents(p: PriceState, at: number): number {
  const base =
    p.hasStore && CONFIG.STORE_PREMIUM_EARNS_RENT ? currentPrice(p, at) : landPrice(p, at);
  return Math.round(base * 100 * CONFIG.RENT_RATE);
}

export function hourlyBusinessRentCents(p: PriceState): number {
  return p.hasStore ? CONFIG.BUSINESS_RENT_CENTS_PER_HOUR : 0;
}

export interface RentSettlement {
  /** Whole hours paid (at most RENT_BANK_HOURS). */
  hours: number;
  landCents: number;
  businessCents: number;
  /** New rent_settled_at, epoch ms. A fractional hour carries over unless the bank overflowed. */
  settledAt: number;
}

/**
 * Rent owed on one parcel for every whole hour since `settledAt`, capped at RENT_BANK_HOURS.
 * With `prorate`, the trailing partial hour is paid too, "up to this moment": used when the
 * parcel is about to change (a sale, an owner visit restoring the price, a store opening), so
 * the time before the change is priced at the rate that applied then.
 */
export function settleRent(p: PriceState, settledAt: number, now: number, prorate = false): RentSettlement {
  const elapsed = Math.max(0, Math.floor((now - settledAt) / HOUR_MS));
  const hours = Math.min(elapsed, CONFIG.RENT_BANK_HOURS);
  let landCents = 0;
  for (let k = 0; k < hours; k++) landCents += hourlyLandRentCents(p, settledAt + k * HOUR_MS);
  let businessCents = hours * hourlyBusinessRentCents(p);
  const overflowed = elapsed > CONFIG.RENT_BANK_HOURS;
  let next = overflowed ? now : settledAt + hours * HOUR_MS;
  if (prorate && !overflowed && now > next) {
    const frac = (now - next) / HOUR_MS;
    landCents += Math.round(hourlyLandRentCents(p, next) * frac);
    businessCents += Math.round(hourlyBusinessRentCents(p) * frac);
    next = now;
  }
  return { hours, landCents, businessCents, settledAt: next };
}

export interface SalaryState {
  /** Last time the player opened (was active in) the app, epoch ms. */
  lastOpenAt: number;
  /** Start of unpaid eligible salary time, epoch ms. */
  salarySettledAt: number;
}

export interface SalarySettlement extends SalaryState {
  hours: number;
  cents: number;
}

/**
 * Salary is paid for whole hours inside the SALARY_WINDOW_HOURS after the last
 * app open. Pass open=true when this settlement is itself an app open: the
 * window then restarts from `now`.
 */
export function settleSalary(s: SalaryState, now: number, open: boolean): SalarySettlement {
  const windowEnd = s.lastOpenAt + CONFIG.SALARY_WINDOW_HOURS * HOUR_MS;
  const eligibleEnd = Math.min(now, windowEnd);
  let settled = s.salarySettledAt;
  let hours = 0;
  if (eligibleEnd > settled) {
    hours = Math.floor((eligibleEnd - settled) / HOUR_MS);
    settled += hours * HOUR_MS;
  }
  let lastOpenAt = s.lastOpenAt;
  if (open) {
    // A window that already closed forfeits its last partial hour; the new window starts now.
    if (now >= windowEnd) settled = now;
    lastOpenAt = now;
  }
  return { hours, cents: hours * CONFIG.SALARY_CENTS_PER_HOUR, lastOpenAt, salarySettledAt: settled };
}

/** What a triggered Spook takes from the buyer, in cents. */
export function spookTakeCents(priceDollars: number, buyerCashAfterCents: number): number {
  const want = Math.max(
    CONFIG.SPOOK_MIN_TAKE * 100,
    Math.round(priceDollars * 100 * CONFIG.SPOOK_TAKE_FRACTION),
  );
  return Math.max(0, Math.min(want, buyerCashAfterCents));
}

/** Seller's share of a purchase price, in cents. */
export function sellerShareCents(priceDollars: number): number {
  return Math.round(priceDollars * 100 * CONFIG.SELLER_SHARE);
}

export type ParcelColor = 'unowned' | 'mine' | 'yellow' | 'orange' | 'red';

export function parcelColor(ownerId: number | null, myId: number | null, price: number): ParcelColor {
  if (ownerId == null) return 'unowned';
  if (myId != null && ownerId === myId) return 'mine';
  if (price >= CONFIG.COLOR_RED_AT) return 'red';
  if (price >= CONFIG.COLOR_ORANGE_AT) return 'orange';
  return 'yellow';
}

/** Store item price in dollars for a buyer at a given place. */
export function itemPrice(
  item: 'spook' | 'flare' | 'lawyer' | 'permit',
  place: 'office' | 'store',
  isStoreOwner = false,
): number | null {
  if (place === 'office') {
    switch (item) {
      case 'lawyer':
        return CONFIG.LAWYER_PRICE;
      case 'permit':
        return CONFIG.PERMIT_PRICE;
      case 'spook':
        return CONFIG.SPOOK_OFFICE_PRICE;
      case 'flare':
        return CONFIG.FLARE_OFFICE_PRICE;
    }
  }
  const base = item === 'spook' ? CONFIG.SPOOK_STORE_PRICE : item === 'flare' ? CONFIG.FLARE_STORE_PRICE : null;
  if (base == null) return null;
  return isStoreOwner ? roundDollars(base * CONFIG.STORE_OWNER_PRICE_FRACTION) : base;
}

export function formatDollars(cents: number, withCents = false): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const s = withCents
    ? (abs / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : Math.floor(abs / 100).toLocaleString('en-US');
  return `${neg ? '-' : ''}$${s}`;
}
