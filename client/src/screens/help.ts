import { CONFIG } from '../../../shared/config.ts';
import { ART, ICON } from '../art.ts';
import { COLORS } from '../map.ts';
import { state } from '../state.ts';
import { dialog, guide, openSheet } from '../ui.ts';
import { dollars, html, money, raw, storage, store } from '../util.ts';

export function showHelp() {
  const c = CONFIG;
  const sw = (color: string, label: string) => html`<span class="legend"><span class="swatch" style="background:${color}"></span>${label}</span>`;
  openSheet({
    title: 'Help',
    className: 'help-sheet',
    body: html`
      ${guide(
        html`I'm ${c.GUIDE_NAME}, clerk at the ${c.GAME_NAME} Land Office. The whole world is cut into parcels about 550 m tall and 400 m wide. Stand on one and it can be yours.`,
        ART.mabel,
      )}
      <h3>The map</h3>
      <div class="legend-row">
        ${sw(COLORS.unowned, 'Open land')} ${sw(COLORS.mine, 'Yours')}
        ${sw(COLORS.yellow, `Others, under ${dollars(c.COLOR_ORANGE_AT)}`)} ${sw(COLORS.orange, `${dollars(c.COLOR_ORANGE_AT)}–${dollars(c.COLOR_RED_AT - 1)}`)}
        ${sw(COLORS.red, `${dollars(c.COLOR_RED_AT)} and up`)}
      </div>
      <p>The number in each parcel's corner is its current price. ${raw(ART.ghost)} marks a Spook, ${raw(ART.cabin)} a store and ${raw(ART.nugget)} a prize. Zoomed out, owned land shows as dots. Tap ${raw(ICON.follow)} to keep the map following you.</p>

      <h3>Buying land</h3>
      <p>Walk into a parcel and tap the big button at the bottom. Open land costs ${dollars(c.UNOWNED_PRICE)}. Your GPS must be accurate to ${c.MAX_ACCURACY_M} m. After a sale the parcel's max price becomes ${c.MAX_PRICE_MULTIPLIER}× what was paid (at least ${dollars(c.MIN_MAX_PRICE)}), and it's locked for ${c.PURCHASE_LOCK_HOURS} hours.</p>

      <h3>Prices fall if you stay away</h3>
      <p>Right after a purchase, or whenever you visit, a parcel's price sits at its max. Then it slides down to half over ${Math.round(c.DECAY_HOURS / 24)} days (never below ${dollars(c.MIN_PRICE)}). Neglected land earns half the rent and costs half as much to take.</p>

      <h3>Getting paid</h3>
      <p>Every parcel pays ${Math.round(c.RENT_RATE * 100)}% of its current price every hour. Rent banks for up to ${c.RENT_BANK_HOURS} hours, so check in at least every few days. You also earn a salary of ${money(c.SALARY_CENTS_PER_HOUR)} an hour for the ${c.SALARY_WINDOW_HOURS} hours after you open the app. Income is paid when you check in.</p>

      <h3>Claim jumping</h3>
      <p>Anyone standing on your parcel can buy it at its current price. You get ${Math.round(c.SELLER_SHARE * 100)}% and the rest leaves the economy. You'll get an alert if you turn them on in User Details.</p>

      <h3>Items</h3>
      <ul class="items-help">
        <li>${raw(ART.ghost)} <b>Spook</b>: place on land you own while standing on it. When someone jumps it, it takes the larger of ${dollars(c.SPOOK_MIN_TAKE)} or ${Math.round(c.SPOOK_TAKE_FRACTION * 100)}% of the price from them and gives it to you. Everyone can see it.</li>
        <li>${raw(ART.flare)} <b>Flare</b>: burns off a Spook as you buy, before it can steal.</li>
        <li>${raw(ART.lawyer)} <b>Lawyer</b> (${dollars(c.LAWYER_PRICE)}): buy any parcel within ${c.LAWYER_RANGE_KM} km of your last verified location without going there. Can't use a Flare.</li>
        <li>${raw(ART.permit)} <b>Building Permit</b> (${dollars(c.PERMIT_PRICE)}): build a store on your land.</li>
      </ul>
      <p>You can carry ${c.MAX_SPOOKS} Spooks and ${c.MAX_FLARES} Flares.</p>

      <h3>Stores</h3>
      <p>A store sells Spooks (${dollars(c.SPOOK_STORE_PRICE)}) and Flares (${dollars(c.FLARE_STORE_PRICE)}) to anyone standing in it, half the Land Office price. The owner gets ${Math.round(c.STORE_OWNER_SHARE * 100)}% of every sale, ${money(c.BUSINESS_RENT_CENTS_PER_HOUR)}/h in business rent, and buys at half price. A store adds ${dollars(c.STORE_PRICE_PREMIUM)} to the parcel's price, which stops decaying, and goes with the parcel if it's jumped.</p>

      <h3>Prizes and promotions</h3>
      <p>Each night gold nuggets appear near everyone who played that week. You'll see them within ${c.PRIZE_VISIBLE_KM} km; stand on the parcel to take one. They pay $10–$100, sometimes a Lawyer, and vanish after ${c.PRIZE_EXPIRY_HOURS} hours. Local businesses post offers under Promotions, and some have printed codes: scan one there with your phone's camera for a free Flare once a day.</p>

      <h3>Leaderboards</h3>
      <p>Six boards are tallied every night, worldwide and within ${c.LOCAL_BOARD_KM} km of you: Most Money, Most Land Parcels, Most Expensive Land, Total Land Value, Shop Keep and Spectral Thief.</p>

      <h3>Fair play</h3>
      <p>Your phone reports where you are; the game checks that fixes are fresh, accurate and physically possible. Faking your location gets accounts reviewed and frozen. The app only sees your location while it's open on screen.</p>

      <p class="muted small">${c.GAME_NAME} is a fan-made game inspired by a 2009 location game. In-game money only: nothing here is real currency.</p>
      <button class="btn" data-intro>Show the welcome tour again</button>
    `,
  });
  document.querySelector('[data-intro]')?.addEventListener('click', () => intro(true));
}

/** First-run welcome from the guide. Resolves when dismissed. */
export async function intro(force = false): Promise<void> {
  if (!force && storage<boolean>('introSeen', false)) return;
  store('introSeen', true);
  const c = CONFIG;
  const steps = [
    html`${guide(html`Howdy, stranger! I'm ${c.GUIDE_NAME} from the Land Office. ${c.GAME_NAME} turns the real map into land you can own.`, ART.mabel)}
      <p>The world is a grid of parcels, each about a five-minute walk across. Blue ones are open. Go stand in one and it's yours for ${dollars(c.UNOWNED_PRICE)}.</p>`,
    html`${guide(html`Land pays rent every hour, and I'll pay you a little salary for showing up.`, ART.mabel)}
      <p>Anyone standing on your parcel can buy it out from under you. You keep ${Math.round(c.SELLER_SHARE * 100)}% of the price. Visit your land to keep its price up, and guard it with Spooks ${raw(ART.ghost)}.</p>`,
    html`${guide(html`One more thing: I need to know where you're standing.`, ART.mabel)}
      <p>Your location is only used while the app is open, to check which parcel you're in. ${state.signedIn ? '' : 'You can look around without an account; sign in when you want to buy.'}</p>`,
  ];
  for (let i = 0; i < steps.length; i++) {
    const last = i === steps.length - 1;
    const v = await dialog({
      title: i === 0 ? `Welcome to ${c.GAME_NAME}` : last ? 'Ready to stake a claim?' : 'How it pays',
      body: steps[i]!,
      className: 'intro-modal',
      actions: last ? [{ label: 'Share my location', value: 'go', kind: 'primary' }] : [{ label: 'Next', value: 'next', kind: 'primary' }],
    });
    if (v === 'cancel') return;
  }
}
