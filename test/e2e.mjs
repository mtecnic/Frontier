// Browser smoke test: drives the built client against a running server in headless Chromium
// with a faked GPS position. Usage:
//   E2E_URL=http://localhost:8788 node test/e2e.mjs   (server must run with DEV_LOGIN=1)
// Screenshots land in test-results/.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.E2E_URL ?? 'http://localhost:8788';
const OUT = process.env.E2E_OUT ?? 'test-results';
mkdirSync(OUT, { recursive: true });

const where = { latitude: 36.1702, longitude: -115.1395, accuracy: 12 };
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  geolocation: where,
  permissions: ['geolocation'],
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const step = async (name, fn) => {
  process.stdout.write(`- ${name} ... `);
  await fn();
  console.log('ok');
};

await step('load app', async () => {
  await page.goto(BASE + '/');
  await page.waitForSelector('body.ready', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#here-top')?.textContent?.includes('Buy'), null, { timeout: 15000 });
  await page.waitForTimeout(800);
  await shot('01-map-anonymous');
});

await step('open parcel info anonymously', async () => {
  await page.click('#here-btn');
  await page.waitForSelector('.sheet.open .parcel-head');
  await shot('02-parcel-anonymous');
});

await step('sign up with email code', async () => {
  await page.click('.sheet.open a[href="#/login"]');
  await page.waitForSelector('.sheet.open input[type=email]');
  await page.fill('input[type=email]', 'player1@example.com');
  await shot('03-login');
  await page.click('.sheet.open button[type=submit]');
  await page.waitForSelector('.code-input');
  await page.waitForFunction(() => document.querySelector('.code-input')?.value?.length === 6);
  await page.click('.sheet.open button[type=submit]');
  await page.waitForSelector('input[name=username]');
  await page.fill('input[name=username]', 'player1');
  await page.click('.sheet.open button[type=submit]');
  await page.waitForFunction(() => document.body.classList.contains('signed-in'));
  await page.waitForTimeout(500);
});

await step('buy the parcel underfoot', async () => {
  await page.waitForFunction(() => document.querySelector('#here-top')?.textContent?.startsWith('Buy'));
  await page.click('#here-btn');
  await page.waitForSelector('.sheet.open [data-action=buy]');
  await shot('04-parcel-buy');
  await page.click('.sheet.open [data-action=buy]');
  await page.waitForSelector('.toast.good');
  await page.waitForFunction(() => document.querySelector('#here-top')?.textContent === 'Yours');
  await page.waitForTimeout(600);
  await shot('05-bought');
});

await step('place the starter Spook', async () => {
  await page.click('.sheet.open [data-action=spook]');
  await page.waitForSelector('.sheet.open .badge >> text=Spooked');
  await page.click('.sheet.open [data-close]');
  await page.waitForTimeout(800);
  await shot('06-map-owned');
});

await step('zoom in to see corner prices', async () => {
  await page.evaluate(() => window.scrollTo(0, 0));
  for (let i = 0; i < 3; i++) {
    await page.mouse.dblclick(195, 420);
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1200);
  await shot('07-map-zoomed');
});

for (const [hash, name, sel] of [
  ['#/me', '08-user-details', '.me-head'],
  ['#/office', '09-land-office', '.shop-list'],
  ['#/prizes', '10-prizes', '.guide'],
  ['#/promos', '11-promotions', '.guide'],
  ['#/boards', '12-boards', '.chips'],
  ['#/help', '13-help', '.legend-row'],
  ['#/more', '14-menu', '.menu'],
]) {
  await step(`screen ${hash}`, async () => {
    await page.evaluate((h) => (location.hash = h), hash);
    await page.waitForSelector(`.sheet.open ${sel}`, { timeout: 10000 });
    await page.waitForTimeout(400);
    await shot(name);
  });
}

await step('buy a Flare at the Land Office', async () => {
  await page.evaluate(() => (location.hash = '#/office'));
  await page.waitForSelector('.sheet.open [data-item=flare]');
  const before = await page.textContent('#inv-flares');
  await page.click('.sheet.open [data-item=flare]');
  await page.waitForFunction((b) => document.querySelector('#inv-flares')?.textContent !== b, before);
});

// ---- Second player jumps the claim (after the 24h lock) using a Flare ----
const ctx2 = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  geolocation: { ...where, latitude: where.latitude + 0.0001 },
  permissions: ['geolocation'],
});
const page2 = await ctx2.newPage();
page2.on('pageerror', (e) => errors.push(`p2 pageerror: ${e.message}`));
const shot2 = (name) => page2.screenshot({ path: `${OUT}/${name}.png` });

async function signUp(p, email, username) {
  await p.goto(BASE + '/#/login');
  await p.waitForSelector('.sheet.open input[type=email]');
  await p.fill('input[type=email]', email);
  await p.click('.sheet.open button[type=submit]');
  await p.waitForFunction(() => document.querySelector('.code-input')?.value?.length === 6);
  await p.click('.sheet.open button[type=submit]');
  await p.waitForSelector('input[name=username]');
  await p.fill('input[name=username]', username);
  await p.click('.sheet.open button[type=submit]');
  await p.waitForFunction(() => document.body.classList.contains('signed-in'));
}

await step('second player signs up', async () => {
  await signUp(page2, 'player2@example.com', 'player2');
  await page2.waitForFunction(() => document.querySelector('#here-top')?.textContent?.startsWith('Locked'), null, { timeout: 15000 });
  await page2.waitForTimeout(400);
  await shot2('15-locked-for-player2');
});

await step('25 hours pass; player2 jumps with a Flare', async () => {
  await page2.evaluate(async () => {
    await fetch('./api/test/clock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ advanceMs: 25 * 3600 * 1000 }) });
  });
  await page2.reload();
  await page2.waitForSelector('body.ready');
  await page2.waitForFunction(() => document.querySelector('#here-top')?.textContent?.startsWith('Jump'), null, { timeout: 15000 });
  // A day away is a new login: the "since you were last here" report pops up.
  await page2.waitForSelector('.modal-wrap.show .ledger-table', { timeout: 10000 });
  await shot2('16a-summary');
  await page2.click('.modal-wrap.show .btn');
  await page2.waitForSelector('.modal-wrap', { state: 'detached' });
  await page2.click('#here-btn');
  await page2.waitForSelector('.sheet.open #use-flare');
  await shot2('16-jump-with-flare');
  await page2.click('.sheet.open [data-action=buy]');
  await page2.waitForSelector('.toast.good >> text=jumped');
  await page2.waitForSelector('.toast.gold >> text=Flare');
  await page2.waitForFunction(() => document.querySelector('#here-top')?.textContent === 'Yours');
  await page2.waitForTimeout(500);
  await shot2('17-jumped');
});

await step('player1 sees the loss in the since-last-login summary', async () => {
  await page.reload();
  await page.waitForSelector('body.ready');
  await page.waitForSelector('.modal-wrap.show .ledger-table', { timeout: 10000 });
  await shot('18a-player1-summary');
  await page.click('.modal-wrap.show .btn');
  await page.waitForSelector('.modal-wrap', { state: 'detached' });
  await page.evaluate(() => (location.hash = '#/me'));
  await page.waitForSelector('.sheet.open .ledger-table');
  const lost = await page.textContent('.sheet.open .ledger-table');
  if (!/Parcels Lost\s*1/.test(lost)) throw new Error('summary does not show the lost parcel: ' + lost);
  await shot('18-player1-after-jump');
});

await step('admin screen', async () => {
  const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 860 }, geolocation: where, permissions: ['geolocation'] });
  const p3 = await ctx3.newPage();
  p3.on('pageerror', (e) => errors.push(`p3 pageerror: ${e.message}`));
  await signUp(p3, 'admin@example.com', 'sheriff');
  await p3.evaluate(() => (location.hash = '#/admin'));
  await p3.waitForSelector('.sheet.open .stat-row');
  await p3.screenshot({ path: `${OUT}/19-admin-desktop.png` });
  await p3.click('.sheet.open [data-tab=qr]');
  await p3.waitForSelector('.sheet.open form[data-form=qr]');
  await p3.click('.sheet.open form[data-form=qr] [data-action=here]');
  await p3.fill('.sheet.open form[data-form=qr] input[name=name]', 'Test Saloon counter');
  await p3.click('.sheet.open form[data-form=qr] button[type=submit]');
  await p3.waitForSelector('.sheet.open [data-action=qr-print]');
  await p3.click('.sheet.open [data-tab=promos]');
  await p3.waitForSelector('.sheet.open form[data-form=promo]');
  await p3.click('.sheet.open form[data-form=promo] [data-action=here]');
  await p3.fill('.sheet.open form[data-form=promo] input[name=business]', 'Test Saloon');
  await p3.fill('.sheet.open form[data-form=promo] input[name=title]', 'Sarsaparilla half off');
  await p3.click('.sheet.open form[data-form=promo] button[type=submit]');
  await p3.waitForSelector('.sheet.open .admin-list li >> text=Sarsaparilla');
  await p3.screenshot({ path: `${OUT}/20-admin-promos.png` });
  await ctx3.close();
});

await step('player2 sees the promotion nearby', async () => {
  await page2.evaluate(() => (location.hash = '#/promos'));
  await page2.waitForSelector('.sheet.open .promo-card >> text=Sarsaparilla');
  await shot2('21-promotions');
});

await step('passkey: add one, sign out, sign back in with it', async () => {
  const ctx4 = await browser.newContext({ viewport: { width: 390, height: 844 }, geolocation: where, permissions: ['geolocation'] });
  const p4 = await ctx4.newPage();
  const cdp = await ctx4.newCDPSession(p4);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await signUp(p4, 'keyholder@example.com', 'keyholder');
  await p4.evaluate(() => (location.hash = '#/me'));
  await p4.click('.sheet.open [data-action=passkey]');
  await p4.waitForSelector('.toast.good >> text=Passkey added', { timeout: 15000 });
  await p4.click('.sheet.open [data-action=logout]');
  await p4.waitForFunction(() => !document.body.classList.contains('signed-in'));
  await p4.evaluate(() => (location.hash = '#/login'));
  await p4.click('.sheet.open [data-action=passkey]');
  await p4.waitForFunction(() => document.body.classList.contains('signed-in'), null, { timeout: 15000 });
  await ctx4.close();
});

await browser.close();
if (errors.length) {
  console.log('\nBrowser errors:\n' + errors.join('\n'));
}
const fatal = errors.filter((e) => !/tiles\.openfreemap|Failed to load resource|ERR_TUNNEL|net::/i.test(e));
if (fatal.length) process.exit(1);
console.log('\nE2E smoke passed. Screenshots in', OUT);
