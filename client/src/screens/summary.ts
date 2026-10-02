import { CONFIG } from '../../../shared/config.ts';
import type { Summary } from '../../../shared/types.ts';
import { ART } from '../art.ts';
import { serverNow } from '../state.ts';
import { dialog, guide } from '../ui.ts';
import { ago, html, money, type Raw } from '../util.ts';

/** The original game's login report, as a ledger table. */
export function summaryTable(s: Summary): Raw {
  const line = (label: string, cents: number, cls = '') =>
    html`<tr class="${cls}"><td>${label}</td><td>${money(cents, true)}</td></tr>`;
  return html`<table class="ledger-table">
    <tbody>
      ${line('Salary', s.salaryCents)}
      ${line('Common Rent', s.rentCents)}
      ${line('Store Proceeds', s.storeProceedsCents)}
      ${line('Stolen Money', s.stolenCents)}
      ${s.prizeCents ? line('Prizes', s.prizeCents) : ''}
      ${line('Total Income', s.totalIncomeCents, 'total')}
      <tr class="gap"><td colspan="2"></td></tr>
      <tr><td>Parcels Lost</td><td>${s.parcelsLost}</td></tr>
      ${line('Value of Land Lost', s.landLostCents, s.landLostCents ? 'loss' : '')}
      <tr><td>Spooks Lost</td><td>${s.spooksLost}</td></tr>
    </tbody>
  </table>`;
}

export function showSummary(s: Summary) {
  const quiet = s.totalIncomeCents === 0 && s.parcelsLost === 0 && s.spooksLost === 0;
  if (quiet) return;
  const lines: string[] = [];
  if (s.parcelsLost) lines.push(`Claim jumpers took ${s.parcelsLost} of your parcels.`);
  if (s.stolenCents) lines.push(`Your Spooks scared up ${money(s.stolenCents, true)}.`);
  const say = lines.length ? lines.join(' ') : `The land's been paying while you were away.`;
  dialog({
    title: 'Since you were last here',
    className: 'summary-modal',
    body: html`${guide(html`${say} <span class="muted small">(since ${ago(s.since, serverNow())})</span>`, ART.mabel)}${summaryTable(s)}
      <p class="muted small">Rent banks for up to ${CONFIG.RENT_BANK_HOURS} hours between visits; salary pays for ${CONFIG.SALARY_WINDOW_HOURS} hours after you open the app.</p>`,
    actions: [{ label: 'Back to the map', value: 'ok', kind: 'primary' }],
  });
}
