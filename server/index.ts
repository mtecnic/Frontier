import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { applyConfig } from '../shared/config.ts';
import { env } from './env.ts';
import { pool } from './db.ts';
import { migrate } from './migrate.ts';
import { HttpError, clientIp, parseCookies, readJson, sendJson, RateLimiter, type Ctx } from './http.ts';
import { buildRouter } from './routes.ts';
import { loadSession } from './auth.ts';
import { initPush } from './push.ts';
import { startNightlyScheduler } from './nightly.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function loadGameConfig() {
  if (!existsSync(env.GAME_CONFIG)) return;
  const overrides = JSON.parse(readFileSync(env.GAME_CONFIG, 'utf8'));
  const unknown = applyConfig(Object.fromEntries(Object.entries(overrides).filter(([k]) => !k.startsWith('_'))));
  console.log(`Loaded game rule overrides from ${env.GAME_CONFIG}`);
  if (unknown.length) console.warn(`Ignored unknown config keys: ${unknown.join(', ')}`);
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (!env.SERVE_STATIC || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
  let rel = pathname === '/' ? '/index.html' : pathname;
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return false;
  }
  const file = normalize(join(env.STATIC_DIR, rel));
  if (!file.startsWith(env.STATIC_DIR + sep) && file !== env.STATIC_DIR) return false;
  let st;
  try {
    st = statSync(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const ext = extname(file).toLowerCase();
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const longCache = rel.startsWith('/vendor/') || rel.startsWith('/icons/');
  const headers: Record<string, string> = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': longCache ? 'public, max-age=86400' : 'no-cache',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  headers['Content-Length'] = String(st.size);
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
  return true;
}

function allowedOrigin(req: IncomingMessage, origin: string): boolean {
  if (origin === new URL(env.PUBLIC_URL).origin) return true;
  if (env.CORS_ORIGINS.includes(origin)) return true;
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function start() {
  loadGameConfig();
  await migrate();
  await initPush();
  const router = buildRouter();
  const ipLimiter = new RateLimiter(env.TEST_MODE ? 1_000_000 : 600, 60_000);
  const prefix = env.API_PREFIX.replace(/\/+$/, '');

  const server = createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname;
    const isApi = path === prefix || path.startsWith(prefix + '/');

    if (!isApi) {
      if (serveStatic(req, res, path)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const origin = req.headers.origin;
    if (origin && env.CORS_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE',
          'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, Authorization',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }
    }

    const ip = clientIp(req);
    const setCookies: string[] = [];
    const ctx: Ctx = {
      req,
      res,
      method: req.method ?? 'GET',
      path: path.slice(prefix.length) || '/',
      params: {},
      query: url.searchParams,
      body: {},
      ip,
      cookies: parseCookies(req.headers.cookie),
      user: null,
      sessionHash: null,
      status: 200,
      setCookie(name, value, opts = {}) {
        const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
        if (opts.httpOnly !== false) parts.push('HttpOnly');
        if (env.COOKIE_SECURE) parts.push('Secure');
        if (opts.maxAgeS != null) parts.push(`Max-Age=${opts.maxAgeS}`);
        setCookies.push(parts.join('; '));
      },
    };

    try {
      if (!ipLimiter.take(ip)) throw new HttpError(429, 'rate_limited', 'Too many requests. Slow down a little.');
      const m = router.match(ctx.method, ctx.path);
      if (m === 'method') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
      if (!m) throw new HttpError(404, 'not_found', 'Unknown API route');
      ctx.params = m.params;

      if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
        // CSRF: browsers always send Origin on cross-site writes.
        if (origin && !allowedOrigin(req, origin)) throw new HttpError(403, 'bad_origin', 'Cross-site request refused.');
        const ct = req.headers['content-type'] ?? '';
        if (req.headers['content-length'] !== '0' && ct && !ct.includes('application/json'))
          throw new HttpError(415, 'json_only', 'Send JSON.');
        ctx.body = await readJson(req);
      }

      if (m.route.auth !== 'none') await loadSession(ctx);
      if ((m.route.auth === 'user' || m.route.auth === 'admin') && !ctx.user)
        throw new HttpError(401, 'auth_required', 'Sign in to do that.');
      if (m.route.auth === 'admin' && !ctx.user!.is_admin) throw new HttpError(403, 'admin_only', 'Admins only.');

      const out = await m.route.handler(ctx);
      if (setCookies.length) res.setHeader('Set-Cookie', setCookies);
      sendJson(res, ctx.status, out ?? { ok: true });
    } catch (err) {
      if (setCookies.length) res.setHeader('Set-Cookie', setCookies);
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.code, message: err.message, ...(err.extra ?? {}) });
      } else {
        console.error(`${ctx.method} ${path} failed:`, err);
        sendJson(res, 500, { error: 'server_error', message: 'Something went wrong on our end.' });
      }
    } finally {
      if (env.LOG_REQUESTS) console.log(`${ctx.method} ${path} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });

  server.keepAliveTimeout = 65_000;
  await new Promise<void>((resolve) => server.listen(env.PORT, env.HOST, resolve));
  console.log(`Frontier API listening on http://${env.HOST}:${env.PORT}${prefix} (public URL ${env.PUBLIC_URL})`);
  if (env.SERVE_STATIC) console.log(`Serving static files from ${env.STATIC_DIR}`);
  if (env.TEST_MODE) console.warn('TEST_MODE is on: the game clock can be moved. Never use this in production.');
  if (env.DEV_LOGIN) console.warn('DEV_LOGIN is on: sign-in codes are returned by the API. Never use this in production.');
  startNightlyScheduler();

  const shutdown = () => {
    console.log('Shutting down...');
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}
