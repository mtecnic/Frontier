import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://frontier:frontier@localhost:5432/frontier_test';

/** Wipe the test database and boot the API in-process on a random port. */
export async function startTestServer(): Promise<{ base: string; server: Server }> {
  const admin = new pg.Client({ connectionString: TEST_DB });
  await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.end();

  Object.assign(process.env, {
    DATABASE_URL: TEST_DB,
    TEST_MODE: '1',
    DEV_LOGIN: '1',
    PORT: '0',
    HOST: '127.0.0.1',
    SERVE_STATIC: '0',
    NIGHTLY_IN_PROCESS: '0',
    ADMIN_EMAILS: 'admin@example.com',
    PUBLIC_URL: 'http://localhost',
    GAME_CONFIG: '/nonexistent/game.json',
    SIGNUPS_PER_IP_PER_DAY: '1000',
  });
  const { start } = await import('../server/index.ts');
  const server = await start();
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}/api`, server };
}

export class Client {
  base: string;
  cookie = '';
  userId = 0;
  username = '';
  constructor(base: string) {
    this.base = base;
  }

  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie();
    for (const c of set) {
      const [pair] = c.split(';');
      if (pair!.startsWith('frontier_session=')) this.cookie = pair!.endsWith('=') ? '' : pair!;
    }
    const data: any = await res.json().catch(() => null);
    return { status: res.status, data };
  }

  async ok(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
    const r = await this.call(method, path, body, headers);
    if (r.status >= 400) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }

  async signUp(email: string, username: string) {
    const link = await this.ok('POST', '/auth/link', { email });
    const v = await this.ok('POST', '/auth/verify', { requestId: link.requestId, code: link.devCode });
    if (v.needsUsername) {
      const s = await this.ok('POST', '/auth/signup', { signupToken: v.signupToken, username });
      this.userId = s.me.id;
      this.username = s.me.username;
      return s.me;
    }
    this.userId = v.me.id;
    this.username = v.me.username;
    return v.me;
  }
}

/** A fix inside cell (gy, gx), with a fresh device timestamp. */
export function fixIn(gy: number, gx: number, accuracy = 10, ageMs = 0) {
  const t = Date.now();
  return {
    lat: (gy + 0.5) / 200,
    lng: (gx + 0.5) / 200,
    accuracy,
    timestamp: t - ageMs,
    sentAt: t,
  };
}
