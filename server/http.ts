import type { IncomingMessage, ServerResponse } from 'node:http';
import { env } from './env.ts';

export class HttpError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown> | undefined;
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const bad = (code: string, message: string, extra?: Record<string, unknown>) =>
  new HttpError(400, code, message, extra);
export const conflict = (code: string, message: string, extra?: Record<string, unknown>) =>
  new HttpError(409, code, message, extra);
export const forbidden = (code: string, message: string) => new HttpError(403, code, message);
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);

export interface AuthUser {
  id: number;
  username: string;
  email: string;
  is_admin: boolean;
  frozen: boolean;
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  ip: string;
  cookies: Record<string, string>;
  user: AuthUser | null;
  sessionHash: string | null;
  setCookie(name: string, value: string, opts?: { maxAgeS?: number; httpOnly?: boolean }): void;
  status: number;
}

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

export type AuthMode = 'none' | 'optional' | 'user' | 'admin';

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
  auth: AuthMode;
}

export class Router {
  routes: Route[] = [];

  add(method: string, path: string, auth: AuthMode, handler: Handler) {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), handler, auth });
  }
  get(path: string, auth: AuthMode, handler: Handler) {
    this.add('GET', path, auth, handler);
  }
  post(path: string, auth: AuthMode, handler: Handler) {
    this.add('POST', path, auth, handler);
  }
  patch(path: string, auth: AuthMode, handler: Handler) {
    this.add('PATCH', path, auth, handler);
  }
  delete(path: string, auth: AuthMode, handler: Handler) {
    this.add('DELETE', path, auth, handler);
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | 'method' | null {
    const segs = path.split('/').filter(Boolean);
    let methodMismatch = false;
    for (const route of this.routes) {
      if (route.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = route.parts[i]!;
        if (p.startsWith(':')) {
          try {
            params[p.slice(1)] = decodeURIComponent(segs[i]!);
          } catch {
            ok = false;
            break;
          }
        } else if (p !== segs[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (route.method !== method) {
        methodMismatch = true;
        continue;
      }
      return { route, params };
    }
    return methodMismatch ? 'method' : null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function clientIp(req: IncomingMessage): string {
  if (env.TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first;
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real) return real;
  }
  return req.socket.remoteAddress || 'unknown';
}

export async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'too_large', 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw bad('bad_json', 'Request body is not valid JSON');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

/** Simple fixed-window rate limiter kept in memory (one API process). */
export class RateLimiter {
  private hits = new Map<string, { count: number; reset: number }>();
  private limit: number;
  private windowMs: number;
  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
    setInterval(() => this.sweep(), Math.max(60_000, windowMs)).unref();
  }
  /** Returns true if allowed. */
  take(key: string, cost = 1): boolean {
    const t = Date.now();
    const e = this.hits.get(key);
    if (!e || e.reset <= t) {
      this.hits.set(key, { count: cost, reset: t + this.windowMs });
      return cost <= this.limit;
    }
    if (e.count + cost > this.limit) return false;
    e.count += cost;
    return true;
  }
  private sweep() {
    const t = Date.now();
    for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k);
  }
}

// ---- Input validation helpers ---------------------------------------------

export function num(v: unknown, name: string, min = -Infinity, max = Infinity): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max)
    throw bad('invalid_' + name, `${name} must be a number between ${min} and ${max}`);
  return n;
}

export function optBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1;
}

export function text(v: unknown, name: string, max: number, min = 0): string {
  if (typeof v !== 'string') throw bad('invalid_' + name, `${name} is required`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw bad('invalid_' + name, `${name} must be ${min}-${max} characters`);
  return s;
}
