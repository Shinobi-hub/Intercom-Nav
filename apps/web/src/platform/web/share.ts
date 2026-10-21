import { compactShareData, isSafeExternalUrl } from '../common/urls';

export function openExternalWeb(url: string, win: Window = window): void {
  if (!isSafeExternalUrl(url)) {
    console.warn('[platform] refusing to open', url);
    return;
  }
  win.open(url, '_blank', 'noopener,noreferrer');
}

/** navigator.share. Resolves false when unsupported, refused by canShare, or cancelled by the user. */
export async function shareWeb(
  data: { title?: string; text?: string; url?: string },
  nav: Navigator = navigator,
): Promise<boolean> {
  if (typeof nav.share !== 'function') return false;
  const payload = compactShareData(data);
  if (typeof nav.canShare === 'function' && !nav.canShare(payload)) return false;
  try {
    await nav.share(payload);
    return true;
  } catch {
    return false; // AbortError when the user dismisses the sheet
  }
}
