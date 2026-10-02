import type { ApiErrorBody } from '../../shared/types.ts';
import { storage, store, uuid } from './util.ts';

declare global {
  interface Window {
    FRONTIER_CONFIG?: {
      apiBase?: string;
      mapStyle?: string;
      mapStyleDark?: string;
      defaultCenter?: [number, number];
      defaultZoom?: number;
    };
  }
}

export class ApiError extends Error {
  status: number;
  code: string;
  data: ApiErrorBody | null;
  constructor(status: number, code: string, message: string, data: ApiErrorBody | null) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

const base = new URL((window.FRONTIER_CONFIG?.apiBase ?? './api').replace(/\/+$/, '') + '/', document.baseURI);
const crossOrigin = base.origin !== location.origin;

/** Bearer token, only used when the API lives on another origin (cookies are used otherwise). */
let token: string | null = crossOrigin ? storage<string | null>('token', null) : null;

export function setToken(t: string | null | undefined) {
  if (!crossOrigin) return;
  token = t ?? null;
  store('token', token);
}

export function apiUrl(path: string): string {
  return new URL(path.replace(/^\//, ''), base).toString();
}

export async function api<T = any>(
  method: string,
  path: string,
  body?: unknown,
  opts: { idempotencyKey?: string; retries?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const retries = opts.retries ?? (opts.idempotencyKey ? 3 : 0);
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(apiUrl(path), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'include',
        cache: 'no-store',
      });
    } catch (err) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
        continue;
      }
      throw new ApiError(0, 'offline', navigator.onLine ? "Couldn't reach the server." : "You're offline.", null);
    }
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      /* empty */
    }
    if (!res.ok) {
      if (res.status >= 500 && attempt < retries) {
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
        continue;
      }
      throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? `Request failed (${res.status})`, data);
    }
    return data as T;
  }
}

/** POST that is safe to retry: one idempotency key for all attempts. */
export function apiOnce<T = any>(path: string, body: unknown): Promise<T> {
  return api<T>('POST', path, body, { idempotencyKey: uuid() });
}
