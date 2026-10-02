import webpush from 'web-push';
import { env } from './env.ts';
import { pool, q, q1 } from './db.ts';
import { now } from './clock.ts';

let vapidPublic = '';
let ready = false;

/** Load VAPID keys from the environment, or generate them once and keep them in the database. */
export async function initPush(): Promise<void> {
  let pub = env.VAPID_PUBLIC_KEY;
  let priv = env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    const row = await q1<{ value: { publicKey: string; privateKey: string } }>(pool, "SELECT value FROM kv WHERE key = 'vapid'");
    if (row) {
      pub = row.value.publicKey;
      priv = row.value.privateKey;
    } else {
      const keys = webpush.generateVAPIDKeys();
      await pool.query("INSERT INTO kv (key, value) VALUES ('vapid', $1) ON CONFLICT (key) DO NOTHING", [
        JSON.stringify(keys),
      ]);
      const again = await q1<{ value: { publicKey: string; privateKey: string } }>(
        pool,
        "SELECT value FROM kv WHERE key = 'vapid'",
      );
      pub = again!.value.publicKey;
      priv = again!.value.privateKey;
    }
  }
  // Push services want a contact: an https: URL or a mailto: address.
  let subject = env.VAPID_SUBJECT;
  if (!subject && env.ADMIN_EMAILS[0]) subject = `mailto:${env.ADMIN_EMAILS[0]}`;
  if (!subject && env.PUBLIC_URL.startsWith('https://')) subject = env.PUBLIC_URL;
  if (!subject) subject = 'mailto:admin@example.com';
  if (!/^(https:|mailto:)/.test(subject)) subject = `mailto:${subject}`;
  try {
    webpush.setVapidDetails(subject, pub, priv);
    vapidPublic = pub;
    ready = true;
  } catch (err) {
    console.warn('Web Push disabled:', (err as Error).message);
  }
}

export function vapidPublicKey(): string {
  return vapidPublic;
}

export async function saveSubscription(userId: number, sub: { endpoint: string; keys: { p256dh: string; auth: string } }) {
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, new Date(now())],
  );
}

export async function removeSubscription(userId: number, endpoint: string) {
  await pool.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

/** Fire-and-forget delivery to every device the user registered. Dead endpoints are pruned. */
export async function notifyUser(userId: number, payload: PushPayload): Promise<number> {
  if (!ready) return 0;
  const subs = await q<{ id: number; endpoint: string; p256dh: string; auth: string }>(
    pool,
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId],
  );
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          { TTL: 24 * 3600, urgency: 'high' },
        );
        sent++;
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
        } else {
          console.warn('push failed:', err?.statusCode ?? '', err?.body ?? err?.message ?? err);
        }
      }
    }),
  );
  return sent;
}
