/**
 * Every tunable game rule lives here.
 *
 * Tags follow the design spec:
 *   [original] documented in a surviving source about the 2009 game.
 *   [proposed] the original value is lost; this number was chosen for playability.
 *
 * The server can override any of these at startup from config/game.json
 * (see config/game.example.json) without touching code. The client fetches the
 * effective values from GET /api/config, so both sides always agree.
 *
 * Money amounts named *_CENTS are integer cents; plain prices are whole dollars.
 */
export const DEFAULT_CONFIG = {
  // ---- Identity ----------------------------------------------------------
  GAME_NAME: 'Frontier',
  GUIDE_NAME: 'Mabel',

  // ---- World and parcel grid ---------------------------------------------
  /** [proposed] Cell size in degrees. NEVER change after launch: parcel IDs depend on it. */
  CELL_DEG: 0.005,
  /** [proposed] Individual parcels draw at this zoom and closer; farther out, owned parcels are dots. */
  GRID_MIN_ZOOM: 12,
  /** [proposed] Corner price numbers draw at this zoom and closer. */
  LABEL_MIN_ZOOM: 14,
  /** [proposed] Colour thresholds for other players' land, by current price in dollars. */
  COLOR_ORANGE_AT: 50,
  COLOR_RED_AT: 500,

  // ---- Economy -----------------------------------------------------------
  /** [proposed] A screenshot showed a new account holding $175. */
  START_CASH_CENTS: 200_00,
  /** [proposed] Starter kit, matching the same screenshot. */
  START_SPOOKS: 1,
  START_FLARES: 2,
  /** [proposed amount; 12-hour rule original] */
  SALARY_CENTS_PER_HOUR: 5_00,
  SALARY_WINDOW_HOURS: 12,
  /** [proposed] Price of land nobody owns, in dollars. */
  UNOWNED_PRICE: 5,
  /** [proposed] Max price is set at purchase to this multiple of the price paid, rounded to the dollar. */
  MAX_PRICE_MULTIPLIER: 1.5,
  /** [proposed] Floor for a freshly set max price, in dollars. */
  MIN_MAX_PRICE: 8,
  /** [proposed] Current price falls in a straight line over this many hours ... */
  DECAY_HOURS: 168,
  /** [proposed] ... down to this fraction of max price ... */
  DECAY_FLOOR_FRACTION: 0.5,
  /** [proposed] ... and never below this many dollars. */
  MIN_PRICE: 5,
  /** [proposed rate; hourly rent original] Hourly rent as a fraction of current price. */
  RENT_RATE: 0.02,
  /** [proposed] Rent (land and business) accrues for at most this many hours between logins. */
  RENT_BANK_HOURS: 72,
  /** [proposed] Share of the purchase price paid to the previous owner; the rest leaves the economy. */
  SELLER_SHARE: 0.8,
  /** [proposed] Every purchase locks the parcel for this long. */
  PURCHASE_LOCK_HOURS: 24,

  // ---- Items -------------------------------------------------------------
  /** [original] */
  LAWYER_PRICE: 1000,
  /** [original] */
  PERMIT_PRICE: 10000,
  /** [proposed] */
  SPOOK_STORE_PRICE: 40,
  SPOOK_OFFICE_PRICE: 80,
  FLARE_STORE_PRICE: 20,
  FLARE_OFFICE_PRICE: 40,
  /** [proposed] Carry limits. Lawyers and permits are unlimited. */
  MAX_SPOOKS: 10,
  MAX_FLARES: 10,
  /** [proposed] A Lawyer buys a parcel within this distance of your last verified fix. */
  LAWYER_RANGE_KM: 40,
  /** [proposed] A Spook takes the larger of this many dollars ... */
  SPOOK_MIN_TAKE: 30,
  /** [proposed] ... or this fraction of the price, capped at the buyer's remaining cash. */
  SPOOK_TAKE_FRACTION: 0.5,

  // ---- Stores ------------------------------------------------------------
  /** [proposed amount; field original] */
  BUSINESS_RENT_CENTS_PER_HOUR: 15_00,
  /** [proposed] Owner's share of each sale to another player. */
  STORE_OWNER_SHARE: 0.5,
  /** [proposed] Owners pay this fraction of the store price at their own store. */
  STORE_OWNER_PRICE_FRACTION: 0.5,
  /** [proposed] A store adds this many dollars to the parcel's max price; store parcels never decay. */
  STORE_PRICE_PREMIUM: 7500,
  /**
   * [proposed] Whether the store premium earns 2% land rent. The spec prices a store's
   * payback from its $15/h business rent alone; letting the $7,500 premium earn land
   * rent would pay $150/h and swamp everything else, so by default only the land part
   * of a store parcel earns land rent.
   */
  STORE_PREMIUM_EARNS_RENT: false,

  // ---- Prizes ------------------------------------------------------------
  PRIZES_PER_ACTIVE_PLAYER: 2,
  PRIZE_ACTIVE_DAYS: 7,
  PRIZE_SPAWN_RADIUS_KM: 5,
  PRIZE_VISIBLE_KM: 2,
  PRIZE_EXPIRY_HOURS: 48,
  /** Cash prize tiers in dollars; chances must sum to 1. */
  PRIZE_TIERS: [
    { chance: 0.7, min: 10, max: 25 },
    { chance: 0.25, min: 26, max: 60 },
    { chance: 0.05, min: 61, max: 100 },
  ] as { chance: number; min: number; max: number }[],
  /** One prize in this many is a Lawyer instead of cash. */
  PRIZE_LAWYER_ONE_IN: 50,

  // ---- Leaderboards ------------------------------------------------------
  LOCAL_BOARD_KM: 50,
  BOARD_SIZE: 100,

  // ---- Local-business layer ---------------------------------------------
  PROMO_VISIBLE_KM: 2,
  QR_COOLDOWN_HOURS: 24,

  // ---- Location trust and anti-cheat -------------------------------------
  MAX_ACCURACY_M: 100,
  MAX_FIX_AGE_S: 30,
  MAX_SPEED_KMH: 250,
  FLIGHT_SPEED_KMH: 1000,
  FLIGHT_GAP_MIN: 60,
  /** A purchase needs a verified fix inside the parcel no older than this. */
  BUY_FIX_MAX_AGE_S: 60,
  PURCHASE_COOLDOWN_S: 3,
  FLAG_PURCHASES_PER_DAY: 300,
  /** Flag when this many consecutive accepted fixes report the identical accuracy across several cells. */
  FLAG_SAME_ACCURACY_RUN: 40,
  /** Flag when this many consecutive purchases step through the grid in one straight line. */
  FLAG_STRAIGHT_LINE_RUN: 12,
  /** New accounts younger than this are checked for feeding a single seller. */
  FLAG_FEEDER_ACCOUNT_DAYS: 14,
  FLAG_FEEDER_MIN_PURCHASES: 5,
  FLAG_FEEDER_SHARE: 0.7,

  // ---- Accounts ----------------------------------------------------------
  SESSION_DAYS: 90,
  USERNAME_MIN: 3,
  USERNAME_MAX: 16,
  /** A check-in after this long without activity counts as a new login (shows the summary). */
  LOGIN_GAP_MINUTES: 30,
  LOGIN_CODE_MINUTES: 15,
};

export type GameConfig = typeof DEFAULT_CONFIG;

/** The live config. Mutated in place by applyConfig so every importer sees the same values. */
export const CONFIG: GameConfig = structuredClone(DEFAULT_CONFIG);

/** Merge overrides (from config/game.json on the server, or /api/config on the client). */
export function applyConfig(overrides: Partial<GameConfig> | Record<string, unknown>): string[] {
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in DEFAULT_CONFIG)) {
      unknown.push(key);
      continue;
    }
    const expected = typeof (DEFAULT_CONFIG as Record<string, unknown>)[key];
    if (typeof value !== expected) throw new Error(`Config ${key} must be a ${expected}`);
    (CONFIG as Record<string, unknown>)[key] = structuredClone(value);
  }
  return unknown;
}

export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;
