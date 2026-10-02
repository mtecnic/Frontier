<img src="docs/screenshots/icon.png" width="72" align="right" alt="">

# Frontier

A location-based land-grab game for phones, modeled on *The Great Land Grab* (Android, 2009). The real map is the board: the world is cut into parcels about 550 m × 400 m, you must stand on a parcel to buy it, land pays hourly rent, and anyone standing on your land can buy it out from under you.

It is an installable web app (PWA). There is one persistent map shared by every player, and all money is in-game currency. Accounts, cash, items and every parcel live on the server, so they carry across devices.

<p>
<img src="docs/screenshots/parcel-jump.png" width="250" alt="Parcel Info: jumping a spooked claim with a Flare">
<img src="docs/screenshots/login-summary.png" width="250" alt="The since-last-login report">
<img src="docs/screenshots/land-office.png" width="250" alt="The Land Office">
</p>

## How to play

- **Buy land.** Walk into a parcel and tap the big button. Open land costs $5. Your GPS must be accurate to 100 m.
- **Collect income.** Each parcel pays 2% of its current price every hour, banked for up to 72 hours. You also get a $5/hour salary for the 12 hours after you open the app.
- **Keep it fresh.** After a sale a parcel's max price is 1.5× what was paid. Its price falls to half over 7 days unless the owner visits.
- **Jump claims.** Stand on someone's parcel and buy it at its current price. The old owner gets 80%. Every sale locks the parcel for 24 hours.
- **Use items.** Spooks steal from claim jumpers, Flares burn off Spooks, Lawyers buy remotely within 40 km, and Building Permits put a store on your land.
- **Hunt prizes** (gold nuggets) that appear every night, check **Promotions** from local businesses, and climb six nightly **leaderboards**.

Your guide is **Mabel**, the Land Office clerk. All names, characters and artwork in this repo are original; "Frontier" stands in for the original game's name.

## What's built

All four build phases from the design spec:

| Phase | Done |
|---|---|
| 1. Core loop | Email sign-in (magic link + 6-digit code) with optional passkeys; map with the parcel grid; check-in; buying open and owned land; price decay; lazy salary and rent; Parcel Info and User Details screens; append-only ledger; backups |
| 2. Conflict and items | Spooks, Flares, the Land Office, Lawyers, the 24-hour lock, Web Push jump alerts, location trust checks |
| 3. Stores, prizes, boards | Building Permits and stores (business rent, sales split, owner discount); nightly prizes; six leaderboards in global and local scopes |
| 4. Local-business layer | Promotions; QR refill stations with printable codes; an admin screen for flagged accounts, freezing, offers and stations |

Each phase's "done when" check is covered by tests:

- Two accounts jump each other's parcels and every balance matches its ledger.
- A spooked parcel pays its owner, and a Flare prevents it.
- A store sells to a second player and shows on the Shop Keep board after the nightly run.

## Architecture

```
 phone (PWA, static files)  ──HTTPS──▶  nginx / Apache  ──/api/──▶  Node API (dist/server.mjs)  ──▶  PostgreSQL
   map + location reporter               serves public/               all game rules + nightly job       source of truth
```

The phone never changes cash or ownership itself. Every purchase goes phone → API → one database transaction.

| Path | What it is |
|---|---|
| `shared/config.ts` | **Every tunable rule and number**, tagged original/proposed. Overridable at runtime from `config/game.json`. |
| `shared/pricing.ts`, `shared/grid.ts` | Price decay, rent, salary, Spook math and parcel IDs, used by both server and client |
| `server/` | The API (plain `node:http`, no framework): auth, check-in, purchases, shop, prizes, boards, nightly job, admin |
| `server/migrations/` | SQL schema |
| `client/src/` | The TypeScript single-page app (MapLibre GL JS), service worker and screens |
| `client/static/` | `index.html`, `config.js`, manifest and icons, copied into `public/` |
| `scripts/` | Build, icon generation, backups, restore drill, deploy, DB setup |
| `deploy/` | nginx, Apache, systemd and PostgreSQL WAL-archiving configs |
| `test/` | Unit tests, API integration tests against PostgreSQL, a Playwright browser test |

`npm run build` produces two things:

- `public/`: the static client. Drop this folder in your web root. It uses hash routing, so no rewrite rules are needed.
- `dist/`: the server as a single self-contained file (`dist/server.mjs`, plus `migrate.mjs`, `nightly.mjs` and `migrations/`). It needs no `node_modules` at runtime.

## Run it locally

You need Node.js 20.12+ (22 LTS recommended) and PostgreSQL 13+.

```bash
npm install
sudo scripts/setup-db.sh devpass            # or create a database yourself
cat > .env <<'EOF'
DATABASE_URL=postgres://frontier:devpass@localhost:5432/frontier
PUBLIC_URL=http://localhost:8787
DEV_LOGIN=1
ADMIN_EMAILS=you@example.com
EOF
npm run build
npm start                                   # http://localhost:8787
```

With `DEV_LOGIN=1` the sign-in code is filled in for you instead of being emailed. Codes are also printed to the server log whenever no mail transport is configured. Browsers allow geolocation on `http://localhost`. To test on a phone you need HTTPS, for example through a tunnel. Chrome DevTools → Sensors can fake a location.

For development, `npm run dev` rebuilds the client on change and restarts the server. Run it on Node 22.18+, which can run the TypeScript server directly.

## Deploy on a Linux box

The game needs the static folder **and** the small API process. The API is what makes the map shared and persistent. HTTPS is required: browsers only allow geolocation, service workers and push on secure origins.

1. **Install Node.js 22 and PostgreSQL** (Ubuntu/Debian):
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
   sudo apt install -y nodejs postgresql rsync
   ```
2. **Get the code** and create a service user:
   ```bash
   sudo useradd --system --home /opt/frontier frontier
   sudo git clone https://github.com/mtecnic/Frontier.git /opt/frontier
   sudo chown -R frontier:frontier /opt/frontier
   cd /opt/frontier
   ```
3. **Create the database:** `sudo scripts/setup-db.sh 'a-strong-password'`
4. **Configure:** `cp .env.example .env`, then set `PUBLIC_URL`, `DATABASE_URL`, your SMTP settings (or `SENDMAIL=1`) and `ADMIN_EMAILS`.
5. **Build:** `sudo -u frontier npm ci && sudo -u frontier npm run build`
6. **Publish the static folder.** Copy `public/` into the folder your domain serves:
   ```bash
   sudo rsync -a public/ /var/www/frontier/public/
   ```
   Or point the web server's root at `/opt/frontier/public`. Edit `config.js` in that folder to change the map style, the default map center or the API location. No rebuild is needed.
7. **Run the API:**
   ```bash
   sudo cp deploy/frontier.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now frontier
   ```
   It migrates the database on start and runs the nightly job itself.
8. **Web server:** use `deploy/nginx.conf` or `deploy/apache.conf`. Both serve the static folder and proxy `/api/` to `127.0.0.1:8787`. Then add HTTPS with `sudo certbot --nginx -d your.domain` (or `--apache`).
9. **Backups:** set up continuous WAL archiving with `deploy/postgresql-wal.conf`, then add a nightly dump (kept 30 days) and a monthly restore drill to root's crontab:
   ```
   15 4 * * *  cd /opt/frontier && BACKUP_DIR=/var/backups/frontier scripts/backup.sh --base >> /var/log/frontier-backup.log 2>&1
   30 5 1 * *  cd /opt/frontier && BACKUP_DIR=/var/backups/frontier scripts/restore-test.sh >> /var/log/frontier-backup.log 2>&1
   ```
10. **Sign in** with an email listed in `ADMIN_EMAILS`. The Admin screen is under More.

To update later, run `WEB_ROOT=/var/www/frontier/public scripts/deploy.sh`. It pulls, rebuilds, publishes the client and restarts the API, and keeps your edited `config.js`.

**No Node on the web host?** Build `public/` anywhere, upload it to the static folder, and run the API on any machine you control. Set `apiBase` in `config.js` to that API's URL, and set `CORS_ORIGINS` on the API to the site's origin.

**Serving from a subfolder** (`example.com/frontier/`): everything in `public/` uses relative paths. Proxy `/frontier/api/` to the API and set `API_PREFIX=/frontier/api` in `.env`.

## Configuration

**Server (`.env`)**: see `.env.example` for every option.

| Variable | Purpose |
|---|---|
| `PUBLIC_URL` | Public address of the game; used in sign-in links, passkeys and secure cookies |
| `DATABASE_URL` | PostgreSQL connection string |
| `HOST`, `PORT` | Where the API listens (default `127.0.0.1:8787`) |
| `SMTP_URL` / `SENDMAIL`, `MAIL_FROM` | How sign-in emails are sent |
| `ADMIN_EMAILS` | Accounts that get the Admin screen |
| `SERVE_STATIC`, `STATIC_DIR` | Also serve the client from the API process (default on, `public/`) |
| `NIGHTLY_HOUR_UTC`, `NIGHTLY_IN_PROCESS` | When the nightly job runs. To use cron instead, set `NIGHTLY_IN_PROCESS=0` and run `node dist/nightly.mjs` |
| `GAME_CONFIG` | JSON file of rule overrides (default `config/game.json`) |
| `VAPID_*` | Optional fixed Web Push keys. Otherwise they are generated once and stored in the database |
| `CORS_ORIGINS`, `API_PREFIX` | For an API on another origin or path |

**Client (`public/config.js`)**: `apiBase`, `mapStyle`, `mapStyleDark`, `defaultCenter`, `defaultZoom`. The default map is [OpenFreeMap](https://openfreemap.org), which serves OpenStreetMap vector tiles with no API key and no per-load fees.

**Game rules**: copy `config/game.example.json` to `config/game.json`, keep the keys you want to change, and restart. Before changing anything, check the effect with `npm run simulate` (Node 22.18+). It replays the spec's balance check (casual, regular and heavy players) using the current rules; with the defaults it lands within a day of the spec's table. Every key is documented in `shared/config.ts`. If cash piles up, the spec suggests changing these, in order: `RENT_RATE`, `SALARY_CENTS_PER_HOUR`, `DECAY_HOURS`, `SELLER_SHARE`. Never change `CELL_DEG` after launch, because parcel IDs depend on it.

## Operations

- **Nightly job** (after `NIGHTLY_HOUR_UTC`, once per UTC day, safe across restarts):
  - spawns prizes
  - rebuilds the six leaderboards
  - audits that every player's cash equals their ledger
  - flags accounts that mostly pay one seller or make more than 300 purchases a day
  - prunes old sessions, logs and expired prizes

  You can run it on demand from Admin → Overview.
- **Anti-cheat**: fixes must be fresh (under 30 s), accurate (100 m or better) and physically plausible (250 km/h, or 1,000 km/h after an hour). Every fix is logged.

  Patterns are flagged for review, never blocked automatically: identical accuracy values across many cells, straight grid-order purchase runs, feeder accounts, and more than 300 purchases a day.

  A **frozen** account keeps playing, but it can't buy other players' land, its Spooks fizzle, and its store purchases don't pay the owner. An admin can clear it.
- **Rate limits** key on the player's IP address. Behind nginx or Apache, the API reads the proxy's `X-Real-IP` or `X-Forwarded-For` header. It trusts those headers only on connections from a local or private address. The configs in `deploy/` overwrite any value a client sends.
- **Integrity**: each purchase is one transaction. It takes an advisory lock on the parcel ID plus row locks (parcels before users), so two buyers can't both win. Purchases and shop actions accept an `Idempotency-Key` header, so a retried request never charges twice. Cash has a `CHECK (cash_cents >= 0)` constraint.

## Testing

```bash
npm run typecheck
npm test            # unit + API integration tests (needs PostgreSQL; set TEST_DATABASE_URL)
npm run test:e2e    # Playwright browser test against a running server with DEV_LOGIN=1 TEST_MODE=1
```

The API tests wipe and use `postgres://frontier:frontier@localhost:5432/frontier_test` unless `TEST_DATABASE_URL` says otherwise. They fast-forward a test-only game clock to cover decay, rent banking, locks and prize expiry.

## Design decisions where the spec left room

- **Store parcels and land rent.** Taken literally, 2% rent on a store's +$7,500 would pay $150 an hour, swamping the $15/h business rent the spec prices stores on. By default only the land part of a store parcel earns land rent (`STORE_PREMIUM_EARNS_RENT`). When a store parcel is jumped, the new max is 1.5× the land part of the price, plus the flat $7,500.
- **Partial hours.** Rent is credited per whole hour. When a parcel changes (a sale, an owner visit that restores a slipped price, or a store opening), the partial hour is paid up to that moment at the old rate, so nothing is lost or overpaid.
- **"Opening the app"** for the 12-hour salary window means any check-in, which the app sends on open and while it's on screen. A check-in after 30 minutes of silence counts as a new login and shows the since-last-login report.
- **Login report.** "Spooks Lost" counts your Spooks destroyed by Flares. Business rent is included under Store Proceeds. Prizes get their own line.
- **Local leaderboards** use the nightly snapshot, filtered to players who currently own land within 50 km of you and re-ranked.
- **Lawyers** can't buy a parcel you already own, can't use Flares, and still respect the 24-hour lock.
- **Sign-in** sends both a magic link and a 6-digit code. An installed iPhone web app has its own cookie jar, so a link opened in Safari wouldn't sign the app in; typing the code in the app does.
- **Unowned prices** are $5 everywhere, so corner numbers only appear from zoom 14, where they're readable.

## Credits

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors; tiles by [OpenFreeMap](https://openfreemap.org); rendering by [MapLibre GL JS](https://maplibre.org) (BSD-3-Clause). Inspired by *The Great Land Grab*; its name, its Ol' Henry character and its art belong to the original developer and are not used here.
