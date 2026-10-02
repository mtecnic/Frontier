import { CONFIG } from '../../../shared/config.ts';
import { ART, ICON } from '../art.ts';
import { state } from '../state.ts';
import { openSheet } from '../ui.ts';
import { html, raw } from '../util.ts';

export function showMore() {
  const item = (href: string, icon: string, label: string, sub: string) =>
    html`<a class="menu-item" href="${href}"><span class="menu-icon">${raw(icon)}</span><span><b>${label}</b><br><span class="muted small">${sub}</span></span></a>`;
  openSheet({
    title: CONFIG.GAME_NAME,
    className: 'more-sheet',
    body: html`<nav class="menu">
      ${item('#/me', ICON.me, 'User Details', state.signedIn ? `${state.me?.username}: cash, land, ledger, settings` : 'Sign in or create an account')}
      ${item('#/office', ICON.office, 'Land Office', 'Lawyers, Building Permits, Spooks and Flares')}
      ${item('#/promos', ICON.promos, 'Promotions', 'Offers from local businesses near you')}
      ${item('#/prizes', ART.nugget, 'Prizes', 'Gold nuggets within a couple of km')}
      ${item('#/boards', ICON.boards, 'Leaderboards', 'Six boards, global and local')}
      ${item('#/help', ICON.help, 'Help', `How to play, from ${CONFIG.GUIDE_NAME}`)}
      ${state.me?.isAdmin ? item('#/admin', ICON.admin, 'Admin', 'Flags, frozen accounts, offers, QR stations') : ''}
    </nav>`,
  });
}
