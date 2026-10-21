import { formatRideCode } from '@intercom/shared';
import { Check, Copy, Link, Share2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { rideJoinUrl } from '../../core/links';
import { getServices } from '../../core/services';
import { useRideStore } from '../../core/store';
import { TID } from '../../core/testIds';
import { Button } from '../../ui/Button';
import { errorFeedback, successFeedback, tapFeedback } from '../../ui/feedback';
import { QrCode } from '../../ui/QrCode';
import styles from './sheets.module.css';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older WebViews and insecure origins: fall back to a selected textarea.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

/** QR code, the code itself, and the join link: everything needed to bring a rider in. */
export function ShareSheet() {
  const code = useRideStore((s) => s.ride?.code ?? null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_500);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!code) return null;
  const url = rideJoinUrl(code);
  const formatted = formatRideCode(code);
  const { platform } = getServices();
  const canShare = platform.isNative || typeof navigator.share === 'function';

  async function copy() {
    tapFeedback();
    if (await copyText(url)) {
      successFeedback('sent');
      setCopied(true);
    } else {
      errorFeedback();
    }
  }

  async function share() {
    const shared = await platform.share({
      title: 'Join my ride',
      text: `Join ride ${formatted} on Intercom Nav`,
      url,
    });
    if (!shared) await copy();
  }

  return (
    <div className={styles.share}>
      <div className={styles.qrFrame}>
        <QrCode value={url} size={232} label={`QR code to join ride ${formatted}`} testId={TID.shareQr} className={styles.qr} />
      </div>
      <div className={styles.shareInfo}>
        <div className={styles.bigCode} data-testid={TID.rideCode} data-code={code} aria-label={`Ride code ${formatted}`}>
          {formatted}
        </div>
        <p className={styles.help}>Riders scan this with the phone camera, or type the code on the home screen.</p>
        <button
          type="button"
          className={styles.linkButton}
          data-testid={TID.shareLink}
          data-url={url}
          data-copied={copied}
          aria-label={copied ? 'Link copied' : `Copy link ${url}`}
          onClick={() => void copy()}
        >
          <Link className={styles.linkIcon} aria-hidden="true" />
          <span className={styles.linkText}>{url.replace(/^https?:\/\//, '')}</span>
          <span className={styles.linkAction}>
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy'}
          </span>
        </button>
        {canShare && (
          <Button variant="primary" size="lg" block icon={Share2} onClick={() => void share()}>
            Send invite
          </Button>
        )}
      </div>
    </div>
  );
}
