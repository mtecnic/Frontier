import { CONFIG } from '../../shared/config.ts';
import { ART } from './art.ts';
import { dialog, guide } from './ui.ts';
import { html } from './util.ts';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e as InstallPromptEvent;
});

export function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true;
}

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function canOfferInstall(): boolean {
  return !isStandalone() && (!!deferred || isIos());
}

export async function offerInstall(): Promise<void> {
  if (deferred) {
    await deferred.prompt();
    await deferred.userChoice.catch(() => null);
    deferred = null;
    return;
  }
  await dialog({
    title: `Install ${CONFIG.GAME_NAME}`,
    body: html`${guide(html`Put ${CONFIG.GAME_NAME} on your Home Screen so it opens full screen, and so jump alerts can reach you.`, ART.mabel)}
      <ol><li>Tap the <b>Share</b> button in Safari's toolbar.</li><li>Choose <b>Add to Home Screen</b>.</li><li>Open ${CONFIG.GAME_NAME} from your Home Screen and sign in once more.</li></ol>`,
  });
}
