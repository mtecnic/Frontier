import type { Me } from '../../../shared/types.ts';
import { api, ApiError } from '../api.ts';
import { ART } from '../art.ts';
import { freshFix, startWatching, toApiFix } from '../geo.ts';
import { setMe } from '../state.ts';
import { dialog, guide, toast } from '../ui.ts';
import { html } from '../util.ts';
import { requireLogin } from './login.ts';

/** Deep link from a printed refill-station code: #/qr/<token>. */
export function redeemQrLink(token: string) {
  history.replaceState(null, '', '#/');
  requireLogin(async () => {
    startWatching();
    toast('Checking your location for the refill station...');
    const fix = await freshFix(10_000);
    try {
      const r = await api<{ station: string; me: Me }>('POST', '/qr/redeem', { token, fix: fix ? toApiFix(fix) : undefined });
      setMe(r.me);
      dialog({
        title: 'Free Flare!',
        body: html`${guide(html`Thanks for stopping by <b>${r.station}</b>. Here's a Flare on the house. You now carry ${r.me.inventory.flares}.`, ART.mabel)}`,
      });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not redeem that code.';
      dialog({ title: 'Refill station', body: html`${guide(msg, ART.mabel)}` });
    }
  });
}
