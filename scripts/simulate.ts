// Economy simulator: replays the spec's balance check with the live rules.
//   node scripts/simulate.ts                 (Node 22.18+ runs TypeScript directly)
//   GAME_CONFIG=config/game.json node scripts/simulate.ts   to try tuned values
// Each player buys only $5 land, is never jumped, finds no prizes and saves everything.
import { existsSync, readFileSync } from 'node:fs';
import { CONFIG, HOUR_MS, applyConfig } from '../shared/config.ts';
import { hourlyLandRentCents, nextMaxPrice, type PriceState } from '../shared/pricing.ts';

const file = process.env.GAME_CONFIG ?? 'config/game.json';
if (existsSync(file)) {
  const o = JSON.parse(readFileSync(file, 'utf8'));
  applyConfig(Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_'))));
  console.log(`Using overrides from ${file}\n`);
}

interface Style {
  name: string;
  habits: string;
  opens: number[]; // hours of the day the app is opened
  firstDay: number;
  perDay: number;
  fresh: number; // share of parcels visited daily
}

const STYLES: Style[] = [
  { name: 'Casual', habits: 'opens at 8:00 and 12:00, 8 parcels day one, +2/day, 60% fresh', opens: [8, 12], firstDay: 8, perDay: 2, fresh: 0.6 },
  { name: 'Regular', habits: 'opens at 8:00 and 20:00, 15 parcels day one, +5/day, 60% fresh', opens: [8, 20], firstDay: 15, perDay: 5, fresh: 0.6 },
  { name: 'Heavy', habits: 'opens at 8:00 and 20:00, 30 parcels day one, +12/day, 50% fresh', opens: [8, 20], firstDay: 30, perDay: 12, fresh: 0.5 },
];

function simulate(s: Style, days = 90) {
  const parcels: (PriceState & { fresh: boolean })[] = [];
  let cash = CONFIG.START_CASH_CENTS;
  let lastOpen = -Infinity;
  let day7 = { parcels: 0, perDay: 0 };
  let first1k: number | null = null;
  let first10k: number | null = null;
  let dayIncome = 0;
  for (let h = 0; h < days * 24; h++) {
    const day = Math.floor(h / 24);
    const hod = h % 24;
    const t = h * HOUR_MS;
    if (s.opens.includes(hod)) {
      lastOpen = h;
      if (hod === s.opens[0]) {
        const n = day === 0 ? s.firstDay : s.perDay;
        for (let i = 0; i < n && cash >= CONFIG.UNOWNED_PRICE * 100; i++) {
          cash -= CONFIG.UNOWNED_PRICE * 100;
          const fresh = parcels.filter((p) => p.fresh).length < Math.round((parcels.length + 1) * s.fresh);
          parcels.push({ maxPrice: nextMaxPrice(CONFIG.UNOWNED_PRICE, false), lastVisitAt: t, hasStore: false, fresh });
        }
        for (const p of parcels) if (p.fresh) p.lastVisitAt = t;
      }
    }
    let income = 0;
    if (h - lastOpen < CONFIG.SALARY_WINDOW_HOURS) income += CONFIG.SALARY_CENTS_PER_HOUR;
    for (const p of parcels) income += hourlyLandRentCents(p, t);
    cash += income;
    dayIncome += income;
    if (hod === 23) {
      if (day === 6) day7 = { parcels: parcels.length, perDay: dayIncome };
      dayIncome = 0;
    }
    if (first1k == null && cash >= 1000_00) first1k = day + 1;
    if (first10k == null && cash >= 10000_00) first10k = day + 1;
  }
  return { day7, first1k, first10k };
}

const rows = STYLES.map((s) => ({ s, r: simulate(s) }));
const pad = (v: string, n: number) => v.padEnd(n);
console.log(pad('Player', 9) + pad('Day 7', 26) + pad('First $1,000', 14) + 'First $10,000');
for (const { s, r } of rows) {
  console.log(
    pad(s.name, 9) +
      pad(`${r.day7.parcels} parcels, $${Math.round(r.day7.perDay / 100)} a day`, 26) +
      pad(r.first1k ? `Day ${r.first1k}` : '-', 14) +
      (r.first10k ? `Day ${r.first10k}` : '-'),
  );
}
console.log('\nSpec targets: Casual 20 parcels/$141, day 8, day 44; Regular 45/$258, day 5, day 29; Heavy 102/$414, day 5, day 21.');
for (const { s } of rows) console.log(`  ${s.name}: ${s.habits}`);
