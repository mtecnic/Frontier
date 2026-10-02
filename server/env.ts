import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Load KEY=value pairs from .env (cwd) if present; real environment variables win.
for (const file of [process.env.ENV_FILE, '.env'].filter(Boolean) as string[]) {
  if (existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch (err) {
      console.warn(`Could not load ${file}:`, err);
    }
    break;
  }
}

function str(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function int(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name]?.trim() ? v : fallback;
}

const publicUrl = str('PUBLIC_URL', 'http://localhost:8787').replace(/\/+$/, '');

export const env = {
  PORT: int('PORT', 8787),
  HOST: str('HOST', '127.0.0.1'),
  DATABASE_URL: str('DATABASE_URL', 'postgres://frontier:frontier@localhost:5432/frontier'),
  /** Public origin (and optional path) where players open the game, e.g. https://frontier.example.com */
  PUBLIC_URL: publicUrl,
  /** Path prefix the API is mounted at, as seen by this process. */
  API_PREFIX: str('API_PREFIX', '/api'),
  /** Serve the built client from this folder too (handy when nginx is not serving it). */
  STATIC_DIR: resolve(str('STATIC_DIR', 'public')),
  SERVE_STATIC: bool('SERVE_STATIC', true),
  COOKIE_SECURE: bool('COOKIE_SECURE', publicUrl.startsWith('https://')),
  /** Extra origins allowed to call the API with credentials (comma separated). */
  CORS_ORIGINS: str('CORS_ORIGINS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** Believe X-Real-IP / X-Forwarded-For, but only on connections from a local or private address (your proxy). */
  TRUST_PROXY: bool('TRUST_PROXY', true),
  /** smtp://user:pass@host:587 or smtps://... ; leave empty to use sendmail or the console. */
  SMTP_URL: str('SMTP_URL'),
  SENDMAIL: bool('SENDMAIL', false),
  MAIL_FROM: str('MAIL_FROM', 'Frontier <no-reply@localhost>'),
  /** Comma-separated emails that become admins when they sign in. */
  ADMIN_EMAILS: str('ADMIN_EMAILS')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  /** Return sign-in codes in the API response. Development only! */
  DEV_LOGIN: bool('DEV_LOGIN', false),
  /** Enables the test clock endpoint. Never enable in production. */
  TEST_MODE: bool('TEST_MODE', false),
  /** Hour (0-23, UTC) after which the nightly job runs. */
  NIGHTLY_HOUR_UTC: int('NIGHTLY_HOUR_UTC', 9),
  /** Run the nightly scheduler inside the API process. Disable if you run it from cron instead. */
  NIGHTLY_IN_PROCESS: bool('NIGHTLY_IN_PROCESS', true),
  /** Optional JSON file of game rule overrides. */
  GAME_CONFIG: resolve(str('GAME_CONFIG', 'config/game.json')),
  VAPID_PUBLIC_KEY: str('VAPID_PUBLIC_KEY'),
  VAPID_PRIVATE_KEY: str('VAPID_PRIVATE_KEY'),
  VAPID_SUBJECT: str('VAPID_SUBJECT'),
  /** Max new accounts per IP address per day. */
  SIGNUPS_PER_IP_PER_DAY: int('SIGNUPS_PER_IP_PER_DAY', 5),
  LOG_REQUESTS: bool('LOG_REQUESTS', false),
};
