/** Schemes that must never be handed to window.open or an OS intent from app code. */
const BLOCKED_SCHEMES = new Set(['javascript:', 'data:', 'blob:', 'file:', 'vbscript:', 'about:']);

/** True for absolute URLs we are willing to open outside the app (https maps links, geo:, tel:, ...). */
export function isSafeExternalUrl(url: string): boolean {
  try {
    return !BLOCKED_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Drops undefined fields: navigator.share and the native share sheet treat `url: undefined` oddly. */
export function compactShareData(data: { title?: string; text?: string; url?: string }): ShareData {
  const out: ShareData = {};
  if (data.title) out.title = data.title;
  if (data.text) out.text = data.text;
  if (data.url) out.url = data.url;
  return out;
}
