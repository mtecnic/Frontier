import { env } from './env.ts';

let offsetMs = 0;

/** Server time in epoch ms. All game logic reads time from here, never from SQL now(). */
export function now(): number {
  return Date.now() + offsetMs;
}

export function nowDate(): Date {
  return new Date(now());
}

/** Shift the game clock (TEST_MODE only) so tests can fast-forward decay, rent and expiry. */
export function setClockOffset(ms: number): void {
  if (!env.TEST_MODE) throw new Error('Clock offset is only available in TEST_MODE');
  offsetMs = ms;
}

export function clockOffset(): number {
  return offsetMs;
}
