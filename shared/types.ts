/** JSON shapes exchanged between the client and the API. Times are ISO strings. */

export interface Fix {
  lat: number;
  lng: number;
  /** Reported horizontal accuracy in metres. */
  accuracy: number;
  /** Position.timestamp from the browser, epoch ms (device clock). */
  timestamp: number;
  /** Date.now() on the device when the request was sent, epoch ms (device clock). */
  sentAt: number;
  /** The fix time converted to the server's clock (device time + offset learned from API responses). */
  serverTimestamp: number;
}

export type FixStatus = 'accepted' | 'inaccurate' | 'stale' | 'too_fast' | 'invalid' | 'throttled' | 'none';

export interface Inventory {
  lawyers: number;
  permits: number;
  spooks: number;
  flares: number;
}

export interface Summary {
  since: string;
  salaryCents: number;
  rentCents: number;
  storeProceedsCents: number;
  stolenCents: number;
  prizeCents: number;
  totalIncomeCents: number;
  parcelsLost: number;
  landLostCents: number;
  spooksLost: number;
}

export interface Me {
  id: number;
  username: string;
  email: string;
  cashCents: number;
  inventory: Inventory;
  isAdmin: boolean;
  frozen: boolean;
  parcelsOwned: number;
  landValue: number;
  hourlyIncomeCents: number;
  lastFix: { lat: number; lng: number; at: string; accuracy: number } | null;
  createdAt: string;
  hasPasskey: boolean;
  pushDevices: number;
}

export interface ParcelView {
  id: string;
  gy: number;
  gx: number;
  ownerId: number | null;
  owner: string | null;
  /** Current price in whole dollars. */
  price: number;
  /** Max price in whole dollars, including any store premium. */
  maxPrice: number;
  spook: boolean;
  store: boolean;
  lockedUntil: string | null;
}

export interface ParcelDetail extends ParcelView {
  pricePaid: number | null;
  purchasedAt: string | null;
  lastVisitAt: string | null;
  hourlyRentCents: number;
  businessRentCents: number;
  locked: boolean;
  prize: boolean;
  promotions: PromotionView[];
  history: { time: string; from: string | null; to: string | null; price: number; viaLawyer: boolean }[];
}

export interface PrizeView {
  id: number;
  parcelId: string;
  gy: number;
  gx: number;
  expiresAt: string;
  distanceKm?: number;
}

export interface ClaimedPrize {
  id: number;
  parcelId: string;
  kind: 'cash' | 'lawyer';
  amountCents: number;
  claimedAt: string;
}

export interface PromotionView {
  id: number;
  parcelId: string;
  gy: number;
  gx: number;
  business: string;
  title: string;
  body: string;
  url: string | null;
  endsAt: string | null;
  distanceKm?: number;
}

export interface CheckinResult {
  fix: FixStatus;
  fixMessage?: string;
  cellId: string | null;
  me: Me;
  newLogin: boolean;
  summary: Summary | null;
  income: { salaryCents: number; rentCents: number; businessCents: number };
  /** Set when the fix was on the player's own parcel (an owner visit). */
  visited: { parcelId: string; price: number; previousPrice: number } | null;
  prizes: ClaimedPrize[];
  serverTime: string;
}

export interface BuyResult {
  parcel: ParcelDetail;
  me: Me;
  paid: number;
  sellerReceivedCents: number;
  seller: string | null;
  spook: null | { outcome: 'triggered' | 'flared' | 'fizzled'; takenCents: number };
  viaLawyer: boolean;
}

export type BoardKey =
  | 'money'
  | 'parcels'
  | 'expensive'
  | 'land_value'
  | 'shop_keep'
  | 'spectral_thief';

export interface BoardRow {
  rank: number;
  userId: number;
  username: string;
  value: number;
}

export interface BoardResult {
  board: BoardKey;
  scope: 'global' | 'local';
  date: string | null;
  rows: BoardRow[];
  me: BoardRow | null;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  [k: string]: unknown;
}
