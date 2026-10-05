import type { FixStatus, Me, ParcelView, PrizeView, PromotionView, Summary } from '../../shared/types.ts';
import { storage } from './util.ts';

export interface LocalFix {
  lat: number;
  lng: number;
  accuracy: number;
  timestamp: number;
  heading: number | null;
}

export type Topic = 'me' | 'fix' | 'parcels' | 'follow' | 'online' | 'server-fix' | 'auth';

export const state = {
  me: null as Me | null,
  summary: null as Summary | null,
  signedIn: false,
  booted: false,
  features: { passkeys: false, push: false, email: false, devLogin: false, testMode: false },
  vapidKey: '',
  /** Latest browser position. */
  fix: null as LocalFix | null,
  /** Why we have no position (permission denied, unsupported...). */
  fixError: null as string | null,
  /** Outcome of the last check-in the server processed. */
  serverFix: null as { status: FixStatus; message?: string; cellId: string | null; at: number } | null,
  parcels: new Map<string, ParcelView>(),
  prizes: [] as PrizeView[],
  promotions: [] as PromotionView[],
  follow: storage<boolean>('follow', true),
  wake: storage<boolean>('wake', false),
  online: navigator.onLine,
  /** serverTime - Date.now(), from the last API response that reported it. */
  serverOffset: 0,
};

const listeners = new Map<Topic, Set<() => void>>();

export function on(topic: Topic, fn: () => void): () => void {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic)!.add(fn);
  return () => listeners.get(topic)!.delete(fn);
}

export function emit(topic: Topic): void {
  listeners.get(topic)?.forEach((fn) => {
    try {
      fn();
    } catch (err) {
      console.error(err);
    }
  });
}

export function setMe(me: Me | null): void {
  const wasSignedIn = state.signedIn;
  state.me = me;
  state.signedIn = !!me;
  emit('me');
  if (wasSignedIn !== state.signedIn) emit('auth');
}

export function serverNow(): number {
  return Date.now() + state.serverOffset;
}

export function noteServerTime(iso: string | undefined): void {
  if (!iso) return;
  const t = Date.parse(iso);
  if (Number.isFinite(t)) state.serverOffset = t - Date.now();
}
