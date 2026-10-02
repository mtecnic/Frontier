import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { CONFIG, DAY_MS, MINUTE_MS } from '../shared/config.ts';
import { env } from './env.ts';
import { pool, q, q1, tx } from './db.ts';
import { now } from './clock.ts';
import { sendMail } from './mail.ts';
import { HttpError, RateLimiter, bad, type AuthUser, type Ctx, type Router } from './http.ts';
import { credit } from './economy.ts';
import { buildMe } from './me.ts';

export const SESSION_COOKIE = 'frontier_session';

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function token(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const USERNAME_RE = /^[A-Za-z0-9_-]+$/;

export function validateUsername(raw: unknown): string {
  if (typeof raw !== 'string') throw bad('invalid_username', 'Pick a username.');
  const u = raw.trim();
  if (u.length < CONFIG.USERNAME_MIN || u.length > CONFIG.USERNAME_MAX || !USERNAME_RE.test(u))
    throw bad(
      'invalid_username',
      `Usernames are ${CONFIG.USERNAME_MIN}-${CONFIG.USERNAME_MAX} letters, numbers, _ or -.`,
    );
  if (/^deleted-/i.test(u)) throw bad('invalid_username', 'That username is reserved.');
  return u;
}

// ---- Sessions ---------------------------------------------------------------

export async function createSession(ctx: Ctx, userId: number): Promise<string> {
  const t = token();
  const at = now();
  await pool.query(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used_at, user_agent) VALUES ($1, $2, $3, $4, $3, $5)',
    [sha256(t), userId, new Date(at), new Date(at + CONFIG.SESSION_DAYS * DAY_MS), String(ctx.req.headers['user-agent'] ?? '').slice(0, 300)],
  );
  ctx.setCookie(SESSION_COOKIE, t, { maxAgeS: CONFIG.SESSION_DAYS * 86400 });
  return t;
}

/** Resolve the session cookie (or bearer token). Sessions renew on use, at most once an hour. */
export async function loadSession(ctx: Ctx): Promise<void> {
  let t = ctx.cookies[SESSION_COOKIE];
  const authz = ctx.req.headers.authorization;
  if (!t && authz?.startsWith('Bearer ')) t = authz.slice(7).trim();
  if (!t) return;
  const h = sha256(t);
  const at = now();
  const row = await q1<AuthUser & { expires_at: Date; last_used_at: Date }>(
    pool,
    `SELECT u.id, u.username, u.email, u.is_admin, u.frozen, s.expires_at, s.last_used_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND u.deleted_at IS NULL`,
    [h],
  );
  if (!row || row.expires_at.getTime() < at) return;
  ctx.user = { id: row.id, username: row.username, email: row.email, is_admin: row.is_admin, frozen: row.frozen };
  ctx.sessionHash = h;
  if (at - row.last_used_at.getTime() > 3_600_000) {
    await pool.query('UPDATE sessions SET last_used_at = $2, expires_at = $3 WHERE token_hash = $1', [
      h,
      new Date(at),
      new Date(at + CONFIG.SESSION_DAYS * DAY_MS),
    ]);
    if (ctx.cookies[SESSION_COOKIE]) ctx.setCookie(SESSION_COOKIE, t, { maxAgeS: CONFIG.SESSION_DAYS * 86400 });
  }
}

// ---- Account creation -------------------------------------------------------

async function createUser(email: string, username: string, ip: string): Promise<number> {
  const at = now();
  try {
    return await tx(async (c) => {
      const isAdmin = env.ADMIN_EMAILS.includes(email.toLowerCase());
      const r = await c.query<{ id: number }>(
        `INSERT INTO users (username, email, cash_cents, spooks, flares, created_at, last_open_at,
                            salary_settled_at, income_settled_at, summary_from, is_admin, signup_ip)
         VALUES ($1, $2, 0, $3, $4, $5, $5, $5, $5, $5, $6, $7) RETURNING id`,
        [username, email, CONFIG.START_SPOOKS, CONFIG.START_FLARES, new Date(at), isAdmin, ip],
      );
      const id = r.rows[0]!.id;
      await credit(c, id, CONFIG.START_CASH_CENTS, 'start', at, { note: 'Starting cash' });
      return id;
    });
  } catch (err: any) {
    if (err?.code === '23505') {
      if (String(err.constraint).includes('username'))
        throw new HttpError(409, 'username_taken', 'That username is taken.');
      throw new HttpError(409, 'email_taken', 'That email already has an account.');
    }
    throw err;
  }
}

// ---- Routes -----------------------------------------------------------------

// TEST_MODE lifts the per-IP limits so test suites can create many players from one address.
const ipLimit = (n: number) => (env.TEST_MODE ? 1_000_000 : n);
const linkPerIp = new RateLimiter(ipLimit(10), 10 * MINUTE_MS);
const linkPerEmail = new RateLimiter(4, 10 * MINUTE_MS);
const verifyPerIp = new RateLimiter(ipLimit(30), 10 * MINUTE_MS);
/** Across all of an email's outstanding codes; together with 5 tries per code this caps guessing. */
const verifyPerEmail = new RateLimiter(env.TEST_MODE ? 1_000_000 : 12, 60 * MINUTE_MS);
const passkeyOptionsPerIp = new RateLimiter(ipLimit(30), 10 * MINUTE_MS);
const MAX_CODE_ATTEMPTS = 5;
const signupPerIp = new RateLimiter(env.SIGNUPS_PER_IP_PER_DAY, DAY_MS);

const challenges = new Map<string, { challenge: string; userId: number | null; expires: number }>();
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of challenges) if (v.expires < t) challenges.delete(k);
}, 60_000).unref();

function rp() {
  const u = new URL(env.PUBLIC_URL);
  return { rpID: u.hostname, origin: u.origin };
}

export function registerAuthRoutes(r: Router) {
  r.post('/auth/link', 'none', async (ctx) => {
    const email = String(ctx.body?.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) throw bad('invalid_email', 'Enter a valid email address.');
    if (!linkPerIp.take(ctx.ip) || !linkPerEmail.take(email))
      throw new HttpError(429, 'rate_limited', 'Too many sign-in requests. Try again in a few minutes.');

    const t = token();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const at = now();
    const row = await q1<{ id: number }>(
      pool,
      `INSERT INTO login_requests (email, token_hash, code_hash, created_at, expires_at, ip)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [email, sha256(t), sha256(code), new Date(at), new Date(at + CONFIG.LOGIN_CODE_MINUTES * MINUTE_MS), ctx.ip],
    );
    const link = `${env.PUBLIC_URL}/#/login?token=${t}`;
    const name = CONFIG.GAME_NAME;
    await sendMail(
      email,
      `${code} is your ${name} sign-in code`,
      `Your ${name} sign-in code is ${code}\n\nOr open this link on the device you're playing on:\n${link}\n\n` +
        `The code and link expire in ${CONFIG.LOGIN_CODE_MINUTES} minutes. If you didn't ask for this, ignore this email.`,
      `<p>Your ${name} sign-in code is</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p>` +
        `<p>Or <a href="${link}">tap here to sign in</a> on the device you're playing on.</p>` +
        `<p style="color:#666">The code and link expire in ${CONFIG.LOGIN_CODE_MINUTES} minutes. If you didn't ask for this, ignore this email.</p>`,
    );
    return { requestId: row!.id, ...(env.DEV_LOGIN ? { devCode: code, devToken: t } : {}) };
  });

  r.post('/auth/verify', 'none', async (ctx) => {
    if (!verifyPerIp.take(ctx.ip)) throw new HttpError(429, 'rate_limited', 'Too many attempts. Wait a few minutes.');
    const at = now();
    type Req = { id: number; email: string; code_hash: string; expires_at: Date; used_at: Date | null; attempts: number };
    let req: Req | null;
    if (typeof ctx.body?.token === 'string') {
      req = await q1<Req>(pool, 'SELECT * FROM login_requests WHERE token_hash = $1', [sha256(ctx.body.token)]);
    } else {
      const id = Number(ctx.body?.requestId);
      const code = String(ctx.body?.code ?? '').replace(/\D/g, '');
      if (!Number.isInteger(id) || code.length !== 6) throw bad('invalid_code', 'Enter the 6-digit code from the email.');
      // Count the attempt atomically *before* comparing, so parallel guesses can't exceed the limit.
      const counted = await q1<Req>(
        pool,
        `UPDATE login_requests SET attempts = attempts + 1
          WHERE id = $1 AND used_at IS NULL AND attempts < $2 RETURNING *`,
        [id, MAX_CODE_ATTEMPTS],
      );
      if (!counted) {
        const r = await q1<Req>(pool, 'SELECT * FROM login_requests WHERE id = $1', [id]);
        if (r && !r.used_at && r.attempts >= MAX_CODE_ATTEMPTS)
          throw bad('too_many_attempts', 'Too many wrong codes. Request a new one.');
        throw bad('expired', 'That sign-in code has expired or was already used. Request a new one.');
      }
      if (!verifyPerEmail.take(counted.email.toLowerCase()))
        throw new HttpError(429, 'rate_limited', 'Too many attempts for this email. Wait a few minutes.');
      if (!timingSafeEqual(Buffer.from(sha256(code)), Buffer.from(counted.code_hash)))
        throw bad('invalid_code', "That code isn't right.");
      req = counted;
    }
    if (!req || req.used_at || req.expires_at.getTime() < at)
      throw bad('expired', 'That sign-in link or code has expired or was already used. Request a new one.');

    const signupToken = token();
    const claimed = await pool.query(
      'UPDATE login_requests SET used_at = $2, signup_token_hash = $3 WHERE id = $1 AND used_at IS NULL',
      [req.id, new Date(at), sha256(signupToken)],
    );
    if (!claimed.rowCount) throw bad('expired', 'That sign-in code was already used.');

    const user = await q1<{ id: number; is_admin: boolean }>(
      pool,
      'SELECT id, is_admin FROM users WHERE lower(email) = $1 AND deleted_at IS NULL',
      [req.email.toLowerCase()],
    );
    if (!user) return { needsUsername: true, signupToken, email: req.email };
    if (!user.is_admin && env.ADMIN_EMAILS.includes(req.email.toLowerCase()))
      await pool.query('UPDATE users SET is_admin = true WHERE id = $1', [user.id]);
    const sessionToken = await createSession(ctx, user.id);
    return { me: await buildMe(pool, user.id, at), token: sessionToken };
  });

  r.post('/auth/signup', 'none', async (ctx) => {
    const st = String(ctx.body?.signupToken ?? '');
    const username = validateUsername(ctx.body?.username);
    const at = now();
    const req = await q1<{ id: number; email: string; used_at: Date }>(
      pool,
      'SELECT id, email, used_at FROM login_requests WHERE signup_token_hash = $1',
      [sha256(st)],
    );
    if (!req || !req.used_at || at - req.used_at.getTime() > 30 * MINUTE_MS)
      throw bad('expired', 'Your sign-up expired. Request a new code.');
    const taken = await q1(pool, 'SELECT 1 FROM users WHERE lower(username) = lower($1) AND deleted_at IS NULL', [username]);
    if (taken) throw new HttpError(409, 'username_taken', 'That username is taken.');
    if (!signupPerIp.take(ctx.ip))
      throw new HttpError(429, 'rate_limited', 'Too many new accounts from this network today.');
    const id = await createUser(req.email, username, ctx.ip);
    await pool.query('UPDATE login_requests SET signup_token_hash = NULL WHERE id = $1', [req.id]);
    const sessionToken = await createSession(ctx, id);
    return { me: await buildMe(pool, id, at), token: sessionToken, created: true };
  });

  r.post('/auth/logout', 'optional', async (ctx) => {
    if (ctx.sessionHash) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [ctx.sessionHash]);
    ctx.setCookie(SESSION_COOKIE, '', { maxAgeS: 0 });
    return { ok: true };
  });

  // ---- Passkeys (optional, added after the first email sign-in) ----

  r.post('/auth/passkey/register/options', 'user', async (ctx) => {
    const { rpID } = rp();
    const existing = await q<{ credential_id: string; transports: string[] | null }>(
      pool,
      'SELECT credential_id, transports FROM passkeys WHERE user_id = $1',
      [ctx.user!.id],
    );
    const options = await generateRegistrationOptions({
      rpName: CONFIG.GAME_NAME,
      rpID,
      userName: ctx.user!.username,
      userID: new TextEncoder().encode(`frontier-user-${ctx.user!.id}`),
      attestationType: 'none',
      excludeCredentials: existing.map((e) => ({ id: e.credential_id, transports: e.transports ?? undefined })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    challenges.set(`reg:${ctx.user!.id}`, { challenge: options.challenge, userId: ctx.user!.id, expires: Date.now() + 5 * MINUTE_MS });
    return options;
  });

  r.post('/auth/passkey/register/verify', 'user', async (ctx) => {
    const { rpID, origin } = rp();
    const ch = challenges.get(`reg:${ctx.user!.id}`);
    if (!ch) throw bad('expired', 'Passkey setup timed out. Try again.');
    challenges.delete(`reg:${ctx.user!.id}`);
    let v;
    try {
      v = await verifyRegistrationResponse({
        response: ctx.body?.response,
        expectedChallenge: ch.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
      });
    } catch (err) {
      throw bad('passkey_failed', `Passkey could not be verified: ${(err as Error).message}`);
    }
    if (!v.verified) throw bad('passkey_failed', 'Passkey could not be verified.');
    const cred = v.registrationInfo.credential;
    await pool.query(
      `INSERT INTO passkeys (credential_id, user_id, public_key, counter, transports, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (credential_id) DO NOTHING`,
      [cred.id, ctx.user!.id, Buffer.from(cred.publicKey), cred.counter, cred.transports ?? null, new Date(now())],
    );
    return { ok: true };
  });

  r.post('/auth/passkey/login/options', 'none', async (ctx) => {
    if (!passkeyOptionsPerIp.take(ctx.ip)) throw new HttpError(429, 'rate_limited', 'Too many attempts. Wait a few minutes.');
    const { rpID } = rp();
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
    const id = token(16);
    challenges.set(`auth:${id}`, { challenge: options.challenge, userId: null, expires: Date.now() + 5 * MINUTE_MS });
    return { challengeId: id, options };
  });

  r.post('/auth/passkey/login/verify', 'none', async (ctx) => {
    if (!verifyPerIp.take(ctx.ip)) throw new HttpError(429, 'rate_limited', 'Too many attempts. Wait a few minutes.');
    const { rpID, origin } = rp();
    const key = `auth:${String(ctx.body?.challengeId ?? '')}`;
    const ch = challenges.get(key);
    if (!ch) throw bad('expired', 'Sign-in timed out. Try again.');
    challenges.delete(key);
    const response = ctx.body?.response;
    const cred = await q1<{ credential_id: string; user_id: number; public_key: Buffer; counter: number; transports: string[] | null }>(
      pool,
      `SELECT p.* FROM passkeys p JOIN users u ON u.id = p.user_id
        WHERE p.credential_id = $1 AND u.deleted_at IS NULL`,
      [String(response?.id ?? '')],
    );
    if (!cred) throw bad('unknown_passkey', "That passkey isn't registered here. Sign in with email first.");
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: cred.credential_id,
          publicKey: new Uint8Array(cred.public_key),
          counter: Number(cred.counter),
          transports: (cred.transports ?? undefined) as any,
        },
        requireUserVerification: false,
      });
    } catch (err) {
      throw bad('passkey_failed', `Passkey sign-in failed: ${(err as Error).message}`);
    }
    if (!v.verified) throw bad('passkey_failed', 'Passkey sign-in failed.');
    await pool.query('UPDATE passkeys SET counter = $2, last_used_at = $3 WHERE credential_id = $1', [
      cred.credential_id,
      v.authenticationInfo.newCounter,
      new Date(now()),
    ]);
    const sessionToken = await createSession(ctx, cred.user_id);
    return { me: await buildMe(pool, cred.user_id, now()), token: sessionToken };
  });

  r.delete('/auth/passkeys', 'user', async (ctx) => {
    await pool.query('DELETE FROM passkeys WHERE user_id = $1', [ctx.user!.id]);
    return { ok: true };
  });
}
